import { bufferToUuid, createId, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";
import { enqueueBulkImportInbox } from "../notifications/bulk-import-inbox.events.js";

const json = (value, fallback = null) => value === null || value === undefined
  ? fallback : typeof value === "string" ? JSON.parse(value) : value;
const number = (value) => value === null || value === undefined ? null : Number(value);

function mapJob(row) {
  return {
    id: bufferToUuid(row.id), type: row.import_type, fileName: row.original_filename,
    status: row.status, totalRows: Number(row.total_rows), validRows: Number(row.valid_rows),
    invalidRows: Number(row.invalid_rows), committedRows: Number(row.committed_rows),
    failedRows: Number(row.failed_rows), createdByName: row.created_by_name,
    createdAt: row.created_at, committedAt: row.committed_at,
    recoveryVersion: Number(row.recovery_version || 0),
    lastProgressAt: row.last_progress_at || null,
    leaseActive: Boolean(row.lease_active),
    canResume: row.status === "COMMITTING" && Number(row.recovery_version) === 1 && !row.lease_active,
    needsManualReview: row.status === "COMMITTING" && Number(row.recovery_version || 0) !== 1
  };
}

export async function insertJob({ job, connection }) {
  await connection.execute(
    `INSERT INTO bulk_import_jobs (id, tenant_id, import_type, original_filename, status, created_by,
       recovery_version, inventory_fingerprint)
     VALUES (?, ?, ?, ?, 'VALIDATING', ?, 1, ?)`,
    [uuidToBuffer(job.id), uuidToBuffer(job.tenantId), job.type, job.fileName, uuidToBuffer(job.createdBy),
      job.inventoryFingerprint ? Buffer.from(job.inventoryFingerprint, "hex") : null]
  );
}

export async function insertRow({ row, connection }) {
  await connection.execute(
    `INSERT INTO bulk_import_rows (id, tenant_id, job_id, row_number, status, source_data, normalized_data, errors_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(row.id), uuidToBuffer(row.tenantId), uuidToBuffer(row.jobId), row.rowNumber,
      row.status, JSON.stringify(row.source), row.normalized ? JSON.stringify(row.normalized) : null,
      row.errors?.length ? JSON.stringify(row.errors) : null]
  );
}

export async function finishValidation({ tenantId, jobId, counts, connection }) {
  await connection.execute(
    `UPDATE bulk_import_jobs SET status = ?, total_rows = ?, valid_rows = ?, invalid_rows = ?
      WHERE tenant_id = ? AND id = ?`,
    [counts.invalid ? "VALIDATED_WITH_ERRORS" : "READY", counts.total, counts.valid, counts.invalid,
      uuidToBuffer(tenantId), uuidToBuffer(jobId)]
  );
  if (counts.invalid) await enqueueBulkImportInbox({ tenantId, jobId, stage: "VALIDATION", connection });
}

export async function listJobs({ tenantId, page, pageSize, connection = getPrimaryPool() }) {
  const offset = (page - 1) * pageSize;
  const tenant = uuidToBuffer(tenantId);
  const [[count]] = await connection.execute("SELECT COUNT(*) AS total FROM bulk_import_jobs WHERE tenant_id = ?", [tenant]);
  const [rows] = await connection.execute(
    `SELECT j.*, COALESCE(j.lease_expires_at > UTC_TIMESTAMP(6), 0) AS lease_active,
       CONCAT(u.first_name, ' ', COALESCE(u.last_name, '')) AS created_by_name
       FROM bulk_import_jobs j JOIN users u ON u.id = j.created_by
      WHERE j.tenant_id = ? ORDER BY j.created_at DESC LIMIT ? OFFSET ?`,
    [tenant, pageSize, offset]
  );
  return { items: rows.map(mapJob), total: Number(count.total), page, pageSize,
    totalPages: Math.max(1, Math.ceil(Number(count.total) / pageSize)) };
}

export async function findJob({ tenantId, jobId, connection = getPrimaryPool(), forUpdate = false }) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.execute(
    `SELECT j.*, COALESCE(j.lease_expires_at > UTC_TIMESTAMP(6), 0) AS lease_active,
       CONCAT(u.first_name, ' ', COALESCE(u.last_name, '')) AS created_by_name
       FROM bulk_import_jobs j JOIN users u ON u.id = j.created_by
      WHERE j.tenant_id = ? AND j.id = ?${lock}`,
    [uuidToBuffer(tenantId), uuidToBuffer(jobId)]
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function listRows({ tenantId, jobId, status = null, connection = getPrimaryPool() }) {
  const values = [uuidToBuffer(tenantId), uuidToBuffer(jobId)];
  const statusSql = status ? " AND status = ?" : "";
  if (status) values.push(status);
  const [rows] = await connection.execute(
    `SELECT id, row_number, status, source_data, normalized_data, errors_json
       FROM bulk_import_rows WHERE tenant_id = ? AND job_id = ?${statusSql} ORDER BY row_number`, values
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), rowNumber: Number(row.row_number), status: row.status,
    source: json(row.source_data, {}), normalized: json(row.normalized_data), errors: json(row.errors_json, []) }));
}

export async function markRow({ tenantId, jobId, rowId, status, errors = [], connection }) {
  const [result] = await connection.execute(
    `UPDATE bulk_import_rows SET status = ?, errors_json = ?, committed_at = IF(? = 'COMMITTED', UTC_TIMESTAMP(6), committed_at)
      WHERE tenant_id = ? AND job_id = ? AND id = ? AND status = 'VALID'`,
    [status, errors.length ? JSON.stringify(errors) : null, status,
      uuidToBuffer(tenantId), uuidToBuffer(jobId), uuidToBuffer(rowId)]
  );
  if (result.affectedRows !== 1) throw new Error("IMPORT_ROW_STATE_CONFLICT");
  await connection.execute(
    `UPDATE bulk_import_jobs SET committed_rows = committed_rows + ?, failed_rows = failed_rows + ?,
       last_progress_at = UTC_TIMESTAMP(6), lease_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 5 MINUTE)
       WHERE tenant_id = ? AND id = ?`,
    [status === "COMMITTED" ? 1 : 0, status === "FAILED" ? 1 : 0, uuidToBuffer(tenantId), uuidToBuffer(jobId)]
  );
}

export async function claimJob({ tenantId, jobId, runToken, connection }) {
  const [result] = await connection.execute(
    `UPDATE bulk_import_jobs SET status = 'COMMITTING', recovery_version = 1, run_token = ?,
       lease_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 5 MINUTE)
       WHERE tenant_id = ? AND id = ? AND (status = 'READY' OR
         (status = 'COMMITTING' AND recovery_version = 1 AND
           (lease_expires_at IS NULL OR lease_expires_at <= UTC_TIMESTAMP(6))))`,
    [uuidToBuffer(runToken), uuidToBuffer(tenantId), uuidToBuffer(jobId)]
  );
  return result.affectedRows === 1;
}

// Locks the job for the entire business mutation + row-result transaction.
// An expired runner may continue only until a newer runner claims the token.
export async function lockRun({ tenantId, jobId, runToken, connection }) {
  const [rows] = await connection.execute(
    `SELECT id FROM bulk_import_jobs WHERE tenant_id = ? AND id = ?
       AND status = 'COMMITTING' AND recovery_version = 1 AND run_token = ? FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(jobId), uuidToBuffer(runToken)]
  );
  return rows.length === 1;
}

export async function findNextRow({ tenantId, jobId, connection }) {
  const [rows] = await connection.execute(
    `SELECT id, row_number, normalized_data FROM bulk_import_rows
       WHERE tenant_id = ? AND job_id = ? AND status = 'VALID' ORDER BY row_number LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(jobId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), rowNumber: Number(rows[0].row_number),
    normalized: json(rows[0].normalized_data) } : null;
}

export async function findInventoryFile({ tenantId, fingerprint, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    "SELECT id FROM bulk_import_jobs WHERE tenant_id = ? AND import_type = 'INVENTORY' AND inventory_fingerprint = ?",
    [uuidToBuffer(tenantId), Buffer.from(fingerprint, "hex")]
  );
  return rows[0] ? bufferToUuid(rows[0].id) : null;
}

export async function auditRun({ tenantId, jobId, resumed, context, connection }) {
  await connection.execute(
    `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action,
       entity_type, entity_id, request_id, ip_address, user_agent, before_data, after_data)
       VALUES (?, ?, ?, 'USER', ?, 'BULK_IMPORT', ?, ?, INET6_ATON(?), ?, NULL, ?)`,
    [uuidToBuffer(createId()), uuidToBuffer(tenantId), uuidToBuffer(context.actorUserId),
      resumed ? "bulk.import.resumed" : "bulk.import.started", uuidToBuffer(jobId), context.requestId,
      context.ipAddress || null, context.userAgent?.slice(0, 500) || null,
      JSON.stringify({ recoveryVersion: 1, unfinishedRowsOnly: true })]
  );
}

// The caller must supply the transaction used for both the final result and its inbox event.
export async function finishCommit({ tenantId, jobId, actorUserId, connection }) {
  const [[counts]] = await connection.execute(
    `SELECT SUM(status = 'COMMITTED') AS committed, SUM(status = 'FAILED') AS failed,
       SUM(status NOT IN ('COMMITTED', 'FAILED')) AS unfinished FROM bulk_import_rows
       WHERE tenant_id = ? AND job_id = ?`, [uuidToBuffer(tenantId), uuidToBuffer(jobId)]
  );
  if (Number(counts.unfinished)) throw new Error("IMPORT_ROWS_UNFINISHED");
  const committed = Number(counts.committed); const failed = Number(counts.failed);
  await connection.execute(
    `UPDATE bulk_import_jobs SET status = ?, committed_rows = ?, failed_rows = ?, committed_by = ?, committed_at = UTC_TIMESTAMP(6),
       run_token = NULL, lease_expires_at = NULL, last_progress_at = UTC_TIMESTAMP(6)
      WHERE tenant_id = ? AND id = ?`, [failed ? "COMPLETED_WITH_ERRORS" : "COMPLETED", committed, failed,
      uuidToBuffer(actorUserId), uuidToBuffer(tenantId), uuidToBuffer(jobId)]
  );
  await enqueueBulkImportInbox({ tenantId, jobId, stage: "COMPLETION", connection });
}

export async function existingCatalogKeys({ tenantId, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const [products, variants] = await Promise.all([
    connection.execute("SELECT product_code FROM products WHERE tenant_id = ? AND deleted_at IS NULL", [tenant]),
    connection.execute("SELECT sku FROM product_variants WHERE tenant_id = ? AND deleted_at IS NULL", [tenant])
  ]);
  return { productCodes: new Set(products[0].map((row) => row.product_code.toUpperCase())),
    skus: new Set(variants[0].map((row) => row.sku.toUpperCase())) };
}

export async function pricingContexts({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT so.id AS offer_id, so.seller_sku, so.status, op.price_list_id, op.list_price, op.sale_price, op.cost_price,
            p.product_code, p.name AS product_name, pv.name AS variant_name
       FROM seller_offers so JOIN product_variants pv ON pv.id = so.variant_id AND pv.deleted_at IS NULL
       JOIN products p ON p.id = pv.product_id AND p.deleted_at IS NULL
       LEFT JOIN offer_prices op ON op.offer_id = so.id AND op.ends_at IS NULL
      WHERE so.tenant_id = ? AND so.deleted_at IS NULL`, [uuidToBuffer(tenantId)]
  );
  return rows.map((row) => ({ offerId: bufferToUuid(row.offer_id), sellerSku: row.seller_sku,
    status: row.status, priceListId: bufferToUuid(row.price_list_id), listPrice: number(row.list_price),
    salePrice: number(row.sale_price), costPrice: number(row.cost_price), productCode: row.product_code,
    productName: row.product_name, variantName: row.variant_name || "Standard" }));
}

export async function inventoryContexts({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT w.id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
            so.id AS offer_id, so.seller_sku, p.name AS product_name, pv.name AS variant_name,
            pt.lot_tracking_enabled, pt.expiry_tracking_enabled, pt.serial_tracking_enabled
       FROM warehouses w JOIN seller_offers so ON so.tenant_id = w.tenant_id AND so.merchant_id = w.merchant_id
        AND so.deleted_at IS NULL AND so.status IN ('ACTIVE', 'DRAFT')
       JOIN product_variants pv ON pv.id = so.variant_id AND pv.deleted_at IS NULL
       JOIN products p ON p.id = pv.product_id AND p.deleted_at IS NULL
       JOIN product_types pt ON pt.id = p.product_type_id
      WHERE w.tenant_id = ? AND w.status = 'ACTIVE'`, [uuidToBuffer(tenantId)]
  );
  return rows.map((row) => ({ warehouseId: bufferToUuid(row.warehouse_id), warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name, offerId: bufferToUuid(row.offer_id), sellerSku: row.seller_sku,
    productName: row.product_name, variantName: row.variant_name || "Standard",
    lotTrackingEnabled: Boolean(row.lot_tracking_enabled), expiryTrackingEnabled: Boolean(row.expiry_tracking_enabled),
    serialTrackingEnabled: Boolean(row.serial_tracking_enabled) }));
}

export async function exportProducts({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT p.product_code, p.name, pt.vertical, b.name AS brand, c.name AS category,
            pv.sku, pv.name AS variant_name, pv.barcode, bu.code AS base_uom, su.code AS selling_uom,
            color.display_label AS color, size_opt.display_label AS size, p.approval_status, p.publication_status
       FROM products p JOIN product_types pt ON pt.id = p.product_type_id
       JOIN product_variants pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
       JOIN units_of_measure bu ON bu.id = pv.base_uom_id JOIN units_of_measure su ON su.id = pv.selling_uom_id
       LEFT JOIN brands b ON b.id = p.brand_id
       LEFT JOIN product_categories pc ON pc.product_id = p.id AND pc.is_primary = 1 LEFT JOIN categories c ON c.id = pc.category_id
       LEFT JOIN variant_attribute_values cv ON cv.variant_id = pv.id
       LEFT JOIN attribute_definitions cad ON cad.id = cv.attribute_id AND cad.code = 'COLOR'
       LEFT JOIN attribute_options color ON color.id = cv.option_id AND cad.id IS NOT NULL
       LEFT JOIN variant_attribute_values sv ON sv.variant_id = pv.id
       LEFT JOIN attribute_definitions sad ON sad.id = sv.attribute_id AND sad.code = 'SIZE'
       LEFT JOIN attribute_options size_opt ON size_opt.id = sv.option_id AND sad.id IS NOT NULL
      WHERE p.tenant_id = ? AND p.deleted_at IS NULL ORDER BY p.name, pv.sku`, [uuidToBuffer(tenantId)]
  );
  return rows;
}

export async function exportPricing({ tenantId }) { return pricingContexts({ tenantId }); }

export async function exportInventory({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT w.code AS warehouse_code, w.name AS warehouse_name, so.seller_sku, p.name AS product_name,
            pv.name AS variant_name, ib.on_hand_quantity, ib.reserved_quantity, ib.quarantine_quantity,
            (ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity) AS available_quantity
       FROM inventory_balances ib JOIN warehouses w ON w.id = ib.warehouse_id
       JOIN seller_offers so ON so.id = ib.offer_id JOIN product_variants pv ON pv.id = so.variant_id
       JOIN products p ON p.id = pv.product_id WHERE ib.tenant_id = ? ORDER BY w.code, p.name`,
    [uuidToBuffer(tenantId)]
  );
  return rows;
}
