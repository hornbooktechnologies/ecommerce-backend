import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

const number = (value) => value === null || value === undefined ? null : Number(value);
const iso = (value) => value instanceof Date ? value.toISOString() : value;
const escapeSearch = (value) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

function mapReturn(row) {
  return {
    id: bufferToUuid(row.id), returnNumber: row.return_number, returnType: row.return_type,
    status: row.status, reasonCode: row.reason_code, customerComments: row.customer_comments,
    internalNotes: row.internal_notes, requestedAt: iso(row.requested_at), approvedAt: iso(row.approved_at),
    receivedAt: iso(row.received_at), completedAt: iso(row.completed_at),
    orderId: bufferToUuid(row.customer_order_id), orderNumber: row.order_number,
    sellerOrderId: bufferToUuid(row.seller_order_id), sellerOrderNumber: row.seller_order_number,
    merchantName: row.merchant_name, customerName: row.customer_name || "Guest customer",
    warehouseId: bufferToUuid(row.receiving_warehouse_id), warehouseName: row.warehouse_name,
    itemCount: Number(row.item_count || 0), requestedQuantity: number(row.requested_quantity) || 0,
    refundAmount: number(row.refund_amount) || 0, exchangeStatus: row.exchange_status || null
  };
}

export async function listReturns({ tenantId, filters, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const where = ["rr.tenant_id = ?"];
  const parameters = [tenant];
  if (filters.search) {
    const search = `%${escapeSearch(filters.search)}%`;
    where.push("(rr.return_number LIKE ? ESCAPE '\\\\' OR co.order_number LIKE ? ESCAPE '\\\\' OR oi.product_name LIKE ? ESCAPE '\\\\')");
    parameters.push(search, search, search);
  }
  if (filters.status !== "ALL") { where.push("rr.status = ?"); parameters.push(filters.status); }
  if (filters.type !== "ALL") { where.push("rr.return_type = ?"); parameters.push(filters.type); }
  const whereSql = where.join(" AND ");
  const offset = (filters.page - 1) * filters.pageSize;
  const baseJoin = `FROM return_requests rr
    JOIN customer_orders co ON co.id = rr.customer_order_id
    JOIN seller_orders so ON so.id = rr.seller_order_id
    JOIN merchants m ON m.id = so.merchant_id
    JOIN return_items ri ON ri.return_request_id = rr.id
    JOIN order_items oi ON oi.id = ri.order_item_id
    LEFT JOIN customers c ON c.id = co.customer_id
    LEFT JOIN warehouses w ON w.id = rr.receiving_warehouse_id`;
  const [rowsResult, countResult, summaryResult] = await Promise.all([
    connection.execute(
      `SELECT rr.*, co.order_number, so.seller_order_number, m.display_name AS merchant_name,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
                JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.name'))) AS customer_name,
              w.name AS warehouse_name, COUNT(DISTINCT ri.id) AS item_count,
              SUM(ri.requested_quantity) AS requested_quantity, SUM(ri.refund_amount) AS refund_amount,
              (SELECT e.status FROM exchanges e WHERE e.return_request_id = rr.id ORDER BY e.created_at DESC LIMIT 1) AS exchange_status
         ${baseJoin} WHERE ${whereSql}
        GROUP BY rr.id, co.order_number, so.seller_order_number, m.display_name, customer_name, w.name
        ORDER BY rr.requested_at DESC LIMIT ? OFFSET ?`, [...parameters, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(DISTINCT rr.id) AS total ${baseJoin} WHERE ${whereSql}`, parameters),
    connection.execute(
      `SELECT COUNT(*) AS total, SUM(status = 'REQUESTED') AS requested,
              SUM(status IN ('APPROVED','RECEIVED','INSPECTED')) AS in_progress,
              SUM(status = 'COMPLETED') AS completed, SUM(return_type = 'EXCHANGE') AS exchanges
         FROM return_requests WHERE tenant_id = ?`, [tenant])
  ]);
  const total = Number(countResult[0][0].total || 0);
  const summary = summaryResult[0][0];
  return { items: rowsResult[0].map(mapReturn), total, page: filters.page, pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)), summary: {
      total: Number(summary.total || 0), requested: Number(summary.requested || 0),
      inProgress: Number(summary.in_progress || 0), completed: Number(summary.completed || 0),
      exchanges: Number(summary.exchanges || 0)
    } };
}

export async function listReturnOptions({ tenantId, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const [itemResult, serialResult, replacementResult, warehouseResult] = await Promise.all([
    connection.execute(
      `SELECT oi.id, oi.customer_order_id, oi.seller_order_id, oi.offer_id, oi.product_name,
              oi.variant_name, oi.sku, oi.quantity, oi.line_total, co.order_number,
              so.seller_order_number, m.display_name AS merchant_name, pt.vertical,
              (pt.serial_tracking_enabled OR EXISTS (
                SELECT 1 FROM order_item_bundle_components serial_component
                JOIN product_variants serial_variant ON serial_variant.id = serial_component.component_variant_id
                JOIN products serial_product ON serial_product.id = serial_variant.product_id
                JOIN product_types serial_type ON serial_type.id = serial_product.product_type_id
                WHERE serial_component.order_item_id = oi.id AND serial_type.serial_tracking_enabled = 1
              )) AS serial_tracking_enabled,
              COALESCE((SELECT SUM(serial_component.quantity_per_bundle)
                FROM order_item_bundle_components serial_component
                JOIN product_variants serial_variant ON serial_variant.id = serial_component.component_variant_id
                JOIN products serial_product ON serial_product.id = serial_variant.product_id
                JOIN product_types serial_type ON serial_type.id = serial_product.product_type_id
                WHERE serial_component.order_item_id = oi.id AND serial_type.serial_tracking_enabled = 1), 0)
                AS bundle_serial_units,
              p.is_returnable, p.return_window_days,
              COALESCE((SELECT SUM(ri.requested_quantity) FROM return_items ri
                JOIN return_requests active_rr ON active_rr.id = ri.return_request_id
                WHERE ri.order_item_id = oi.id AND active_rr.status <> 'REJECTED'), 0) AS returned_quantity
         FROM order_items oi JOIN customer_orders co ON co.id = oi.customer_order_id
         JOIN seller_orders so ON so.id = oi.seller_order_id JOIN merchants m ON m.id = so.merchant_id
         JOIN product_variants pv ON pv.id = oi.variant_id JOIN products p ON p.id = pv.product_id
         JOIN product_types pt ON pt.id = p.product_type_id
        WHERE oi.tenant_id = ? AND oi.status = 'FULFILLED' AND co.fulfillment_status IN ('FULFILLED','PARTIALLY_FULFILLED')
          AND p.is_returnable = 1
          AND EXISTS (SELECT 1 FROM fulfillment_items fi JOIN fulfillments f ON f.id = fi.fulfillment_id
            WHERE fi.order_item_id = oi.id AND f.status = 'COMPLETED'
              AND (p.return_window_days IS NULL OR DATE_ADD(f.completed_at, INTERVAL p.return_window_days DAY) >= UTC_TIMESTAMP()))
        ORDER BY co.updated_at DESC, oi.product_name`, [tenant]),
    connection.execute(
      `SELECT fi.order_item_id, sn.id, sn.serial_number FROM fulfillment_item_serials fis
         JOIN fulfillment_items fi ON fi.id = fis.fulfillment_item_id
         JOIN serial_numbers sn ON sn.id = fis.serial_number_id
         JOIN order_items oi ON oi.id = fi.order_item_id
        WHERE oi.tenant_id = ? AND sn.status = 'SOLD'`, [tenant]),
    connection.execute(
      `SELECT original.id AS original_order_item_id, replacement.id, replacement.variant_id,
              pv.name AS variant_name, pv.sku, price.sale_price,
              COALESCE((SELECT SUM(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity)
                FROM inventory_balances ib WHERE ib.offer_id = replacement.id), 0) AS available_quantity
         FROM order_items original JOIN product_variants original_pv ON original_pv.id = original.variant_id
         JOIN seller_orders original_so ON original_so.id = original.seller_order_id
         JOIN seller_offers replacement ON replacement.merchant_id = original_so.merchant_id
          AND replacement.store_id = (SELECT store_id FROM customer_orders WHERE id = original.customer_order_id)
         JOIN product_variants pv ON pv.id = replacement.variant_id AND pv.product_id = original_pv.product_id
          AND pv.id <> original_pv.id AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL
         JOIN offer_prices price ON price.offer_id = replacement.id
          AND (price.starts_at IS NULL OR price.starts_at <= UTC_TIMESTAMP())
          AND (price.ends_at IS NULL OR price.ends_at > UTC_TIMESTAMP())
        WHERE original.tenant_id = ? AND replacement.status <> 'ARCHIVED' AND replacement.deleted_at IS NULL`, [tenant]),
    connection.execute(
      `SELECT w.id, w.code, w.name, m.display_name AS merchant_name FROM warehouses w
         JOIN merchants m ON m.id = w.merchant_id
        WHERE w.tenant_id = ? AND w.status = 'ACTIVE' AND w.deleted_at IS NULL ORDER BY w.name`, [tenant])
  ]);
  const serials = serialResult[0].map((row) => ({ orderItemId: bufferToUuid(row.order_item_id),
    id: bufferToUuid(row.id), number: row.serial_number }));
  const replacements = replacementResult[0].map((row) => ({ orderItemId: bufferToUuid(row.original_order_item_id),
    id: bufferToUuid(row.id), variantId: bufferToUuid(row.variant_id), variantName: row.variant_name,
    sku: row.sku, price: number(row.sale_price), availableQuantity: number(row.available_quantity) || 0 }));
  return {
    items: itemResult[0].map((row) => ({ id: bufferToUuid(row.id), orderId: bufferToUuid(row.customer_order_id),
      sellerOrderId: bufferToUuid(row.seller_order_id), offerId: bufferToUuid(row.offer_id),
      orderNumber: row.order_number, sellerOrderNumber: row.seller_order_number,
      merchantName: row.merchant_name, productName: row.product_name, variantName: row.variant_name,
      sku: row.sku, vertical: row.vertical, serialTracking: Boolean(row.serial_tracking_enabled),
      bundleSerialUnits: number(row.bundle_serial_units) || 0,
      orderedQuantity: number(row.quantity), remainingQuantity: Math.max(0, number(row.quantity) - number(row.returned_quantity)),
      lineTotal: number(row.line_total), serials: serials.filter((serial) => serial.orderItemId === bufferToUuid(row.id)),
      replacementOffers: replacements.filter((offer) => offer.orderItemId === bufferToUuid(row.id))
    })).filter((item) => item.remainingQuantity > 0),
    warehouses: warehouseResult[0].map((row) => ({ id: bufferToUuid(row.id), code: row.code,
      name: row.name, merchantName: row.merchant_name }))
  };
}

export async function findOrderItemForReturn({ tenantId, orderItemId, connection }) {
  const [rows] = await connection.execute(
    `SELECT oi.id, oi.customer_order_id, oi.seller_order_id, oi.offer_id, oi.variant_id,
            oi.quantity, oi.line_total, oi.product_name, oi.variant_name, oi.sku,
            co.store_id, co.order_number, co.fulfillment_status, pt.vertical,
            (pt.serial_tracking_enabled OR EXISTS (
              SELECT 1 FROM order_item_bundle_components serial_component
              JOIN product_variants serial_variant ON serial_variant.id = serial_component.component_variant_id
              JOIN products serial_product ON serial_product.id = serial_variant.product_id
              JOIN product_types serial_type ON serial_type.id = serial_product.product_type_id
              WHERE serial_component.order_item_id = oi.id AND serial_type.serial_tracking_enabled = 1
            )) AS serial_tracking_enabled,
            COALESCE((SELECT SUM(serial_component.quantity_per_bundle)
              FROM order_item_bundle_components serial_component
              JOIN product_variants serial_variant ON serial_variant.id = serial_component.component_variant_id
              JOIN products serial_product ON serial_product.id = serial_variant.product_id
              JOIN product_types serial_type ON serial_type.id = serial_product.product_type_id
              WHERE serial_component.order_item_id = oi.id AND serial_type.serial_tracking_enabled = 1), 0)
              AS bundle_serial_units,
            p.is_returnable, p.return_window_days,
            COALESCE((SELECT SUM(ri.requested_quantity) FROM return_items ri
              JOIN return_requests rr ON rr.id = ri.return_request_id
              WHERE ri.order_item_id = oi.id AND rr.status <> 'REJECTED'), 0) AS returned_quantity,
            (SELECT f.warehouse_id FROM fulfillment_items fi JOIN fulfillments f ON f.id = fi.fulfillment_id
              WHERE fi.order_item_id = oi.id AND f.status = 'COMPLETED' ORDER BY f.completed_at DESC LIMIT 1) AS warehouse_id
       FROM order_items oi JOIN customer_orders co ON co.id = oi.customer_order_id
       JOIN product_variants pv ON pv.id = oi.variant_id JOIN products p ON p.id = pv.product_id
       JOIN product_types pt ON pt.id = p.product_type_id
      WHERE oi.tenant_id = ? AND oi.id = ? AND oi.status = 'FULFILLED' LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(orderItemId)]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return { id: bufferToUuid(row.id), orderId: bufferToUuid(row.customer_order_id),
    sellerOrderId: bufferToUuid(row.seller_order_id), offerId: bufferToUuid(row.offer_id),
    variantId: bufferToUuid(row.variant_id), storeId: bufferToUuid(row.store_id),
    warehouseId: bufferToUuid(row.warehouse_id), orderNumber: row.order_number,
    fulfillmentStatus: row.fulfillment_status, vertical: row.vertical,
    serialTracking: Boolean(row.serial_tracking_enabled),
    bundleSerialUnits: number(row.bundle_serial_units) || 0,
    isReturnable: Boolean(row.is_returnable),
    quantity: number(row.quantity), returnedQuantity: number(row.returned_quantity) || 0,
    lineTotal: number(row.line_total), productName: row.product_name, variantName: row.variant_name, sku: row.sku };
}

export async function findSoldSerials({ tenantId, orderItemId, serialIds, connection }) {
  if (!serialIds.length) return [];
  const placeholders = serialIds.map(() => "?").join(",");
  const [rows] = await connection.execute(
    `SELECT sn.id, sn.serial_number FROM fulfillment_item_serials fis
       JOIN fulfillment_items fi ON fi.id = fis.fulfillment_item_id
       JOIN serial_numbers sn ON sn.id = fis.serial_number_id
       JOIN order_items oi ON oi.id = fi.order_item_id
      WHERE oi.tenant_id = ? AND oi.id = ? AND sn.status = 'SOLD' AND sn.id IN (${placeholders}) FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(orderItemId), ...serialIds.map(uuidToBuffer)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), number: row.serial_number }));
}

export async function nextReturnNumber({ tenantId, storeId, connection }) {
  const [rows] = await connection.execute(
    `SELECT id, prefix, next_number, number_padding FROM number_sequences
      WHERE tenant_id = ? AND store_id = ? AND sequence_type = 'RETURN'
      ORDER BY financial_year IS NULL DESC, financial_year DESC LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(storeId)]
  );
  if (!rows[0]) return null;
  await connection.execute("UPDATE number_sequences SET next_number = next_number + 1, version = version + 1 WHERE id = ?", [rows[0].id]);
  const prefix = String(rows[0].prefix);
  return `${prefix}${prefix.endsWith("-") ? "" : "-"}${String(rows[0].next_number).padStart(Number(rows[0].number_padding), "0")}`;
}

export async function insertReturnRequest({ record, connection }) {
  await connection.execute(
    `INSERT INTO return_requests (id, tenant_id, customer_order_id, seller_order_id, return_number,
       return_type, status, reason_code, customer_comments, internal_notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?)`,
    [uuidToBuffer(record.id), uuidToBuffer(record.tenantId), uuidToBuffer(record.orderId),
      uuidToBuffer(record.sellerOrderId), record.number, record.type, record.reasonCode,
      record.customerComments || null, record.notes || null, uuidToBuffer(record.actorUserId)]
  );
}

export async function insertReturnItem({ item, connection }) {
  await connection.execute(
    `INSERT INTO return_items (id, return_request_id, order_item_id, serial_number_id,
       requested_quantity, reason_code) VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(item.id), uuidToBuffer(item.returnId), uuidToBuffer(item.orderItemId),
      item.serialId ? uuidToBuffer(item.serialId) : null, item.quantity, item.reasonCode]
  );
}

export async function insertReturnBundleSerial({ link, connection }) {
  const [result] = await connection.execute(
    `INSERT INTO return_item_bundle_serials (id, return_item_id, bundle_component_id, serial_number_id)
     SELECT ?, ?, fi.bundle_component_id, fis.serial_number_id
       FROM fulfillment_item_serials fis
       JOIN fulfillment_items fi ON fi.id = fis.fulfillment_item_id
      WHERE fi.order_item_id = ? AND fis.serial_number_id = ?
        AND fi.bundle_component_id IS NOT NULL LIMIT 1`,
    [uuidToBuffer(link.id), uuidToBuffer(link.returnItemId), uuidToBuffer(link.orderItemId),
      uuidToBuffer(link.serialId)]
  );
  return result.affectedRows;
}

export async function getReturn({ tenantId, returnId, connection = getPrimaryPool(), forUpdate = false }) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [requestRows] = await connection.execute(
    `SELECT rr.*, co.order_number, so.seller_order_number, m.display_name AS merchant_name,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
              JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.name'))) AS customer_name,
            w.name AS warehouse_name,
            (SELECT COUNT(*) FROM return_items ri WHERE ri.return_request_id = rr.id) AS item_count,
            (SELECT SUM(ri.requested_quantity) FROM return_items ri WHERE ri.return_request_id = rr.id) AS requested_quantity,
            (SELECT SUM(ri.refund_amount) FROM return_items ri WHERE ri.return_request_id = rr.id) AS refund_amount
       FROM return_requests rr JOIN customer_orders co ON co.id = rr.customer_order_id
       JOIN seller_orders so ON so.id = rr.seller_order_id JOIN merchants m ON m.id = so.merchant_id
       LEFT JOIN customers c ON c.id = co.customer_id LEFT JOIN warehouses w ON w.id = rr.receiving_warehouse_id
      WHERE rr.tenant_id = ? AND rr.id = ? LIMIT 1${lock}`,
    [uuidToBuffer(tenantId), uuidToBuffer(returnId)]
  );
  if (!requestRows[0]) return null;
  const [itemRows, exchangeRows, refundRows] = await Promise.all([
    connection.execute(
      `SELECT ri.*, oi.product_name, oi.variant_name, oi.sku, oi.quantity AS ordered_quantity,
              oi.line_total, sn.serial_number FROM return_items ri JOIN order_items oi ON oi.id = ri.order_item_id
         LEFT JOIN serial_numbers sn ON sn.id = ri.serial_number_id
        WHERE ri.return_request_id = ? ORDER BY oi.product_name, sn.serial_number`, [uuidToBuffer(returnId)]),
    connection.execute(
      `SELECT e.*, pv.name AS replacement_variant, pv.sku AS replacement_sku
         FROM exchanges e JOIN seller_offers so ON so.id = e.replacement_offer_id
         JOIN product_variants pv ON pv.id = so.variant_id WHERE e.tenant_id = ? AND e.return_request_id = ?
         ORDER BY e.created_at DESC`, [uuidToBuffer(tenantId), uuidToBuffer(returnId)]),
    connection.execute(
      `SELECT id, refund_number, status, requested_amount, refunded_amount, provider_reference, completed_at
         FROM refunds WHERE tenant_id = ? AND customer_order_id = ? ORDER BY created_at DESC`,
      [uuidToBuffer(tenantId), requestRows[0].customer_order_id])
  ]);
  const request = mapReturn({ ...requestRows[0], exchange_status: exchangeRows[0][0]?.status || null });
  return { request,
    items: itemRows[0].map((row) => ({ id: bufferToUuid(row.id), orderItemId: bufferToUuid(row.order_item_id),
      serialId: bufferToUuid(row.serial_number_id), serialNumber: row.serial_number,
      productName: row.product_name, variantName: row.variant_name, sku: row.sku,
      orderedQuantity: number(row.ordered_quantity), requestedQuantity: number(row.requested_quantity),
      approvedQuantity: number(row.approved_quantity), receivedQuantity: number(row.received_quantity),
      itemCondition: row.item_condition, disposition: row.disposition,
      inspectionNotes: row.inspection_notes, refundAmount: number(row.refund_amount), lineTotal: number(row.line_total) })),
    exchanges: exchangeRows[0].map((row) => ({ id: bufferToUuid(row.id),
      originalOrderItemId: bufferToUuid(row.original_order_item_id), replacementOfferId: bufferToUuid(row.replacement_offer_id),
      replacementOrderItemId: bufferToUuid(row.replacement_order_item_id), replacementVariant: row.replacement_variant,
      replacementSku: row.replacement_sku, quantity: number(row.quantity),
      priceDifference: number(row.price_difference), taxDifference: number(row.tax_difference),
      status: row.status, createdAt: iso(row.created_at), completedAt: iso(row.completed_at) })),
    refunds: refundRows[0].map((row) => ({ id: bufferToUuid(row.id), refundNumber: row.refund_number,
      status: row.status, requestedAmount: number(row.requested_amount), refundedAmount: number(row.refunded_amount),
      providerReference: row.provider_reference, completedAt: iso(row.completed_at) })) };
}

export async function updateReturnStatus({ tenantId, returnId, fromStatus, toStatus, actorUserId,
  notes, warehouseId = null, connection }) {
  const fields = ["status = ?", "internal_notes = CASE WHEN ? = '' THEN internal_notes ELSE ? END"];
  const values = [toStatus, notes || "", notes || ""];
  if (toStatus === "APPROVED") { fields.push("approved_by = ?", "approved_at = UTC_TIMESTAMP(6)"); values.push(uuidToBuffer(actorUserId)); }
  if (toStatus === "RECEIVED") { fields.push("receiving_warehouse_id = ?", "received_at = UTC_TIMESTAMP(6)"); values.push(uuidToBuffer(warehouseId)); }
  if (toStatus === "COMPLETED") fields.push("completed_at = UTC_TIMESTAMP(6)");
  const [result] = await connection.execute(
    `UPDATE return_requests SET ${fields.join(", ")} WHERE tenant_id = ? AND id = ? AND status = ?`,
    [...values, uuidToBuffer(tenantId), uuidToBuffer(returnId), fromStatus]
  );
  return result.affectedRows;
}

export async function approveReturnItems({ returnId, connection }) {
  await connection.execute("UPDATE return_items SET approved_quantity = requested_quantity WHERE return_request_id = ?", [uuidToBuffer(returnId)]);
}

export async function receiveReturnItems({ returnId, connection }) {
  await connection.execute("UPDATE return_items SET received_quantity = approved_quantity WHERE return_request_id = ?", [uuidToBuffer(returnId)]);
}

export async function listReturnItemsForDisposition({ tenantId, returnId, connection }) {
  const [rows] = await connection.execute(
    `SELECT ri.id, ri.order_item_id, ri.serial_number_id, ri.received_quantity,
            oi.offer_id, oi.quantity AS ordered_quantity, oi.line_total,
            pt.lot_tracking_enabled, pt.serial_tracking_enabled,
            EXISTS(SELECT 1 FROM order_item_bundle_components oibc
              WHERE oibc.order_item_id = oi.id) AS is_bundle
       FROM return_items ri JOIN order_items oi ON oi.id = ri.order_item_id
       JOIN product_variants pv ON pv.id = oi.variant_id JOIN products p ON p.id = pv.product_id
       JOIN product_types pt ON pt.id = p.product_type_id
       JOIN return_requests rr ON rr.id = ri.return_request_id
      WHERE rr.tenant_id = ? AND rr.id = ? FOR UPDATE`, [uuidToBuffer(tenantId), uuidToBuffer(returnId)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), orderItemId: bufferToUuid(row.order_item_id),
    serialId: bufferToUuid(row.serial_number_id), offerId: bufferToUuid(row.offer_id),
    quantity: number(row.received_quantity), orderedQuantity: number(row.ordered_quantity),
    lineTotal: number(row.line_total), lotTracking: Boolean(row.lot_tracking_enabled),
    serialTracking: Boolean(row.serial_tracking_enabled), isBundle: Boolean(row.is_bundle) }));
}

export async function listBundleReturnStock({ tenantId, returnId, connection }) {
  const [rows] = await connection.execute(
    `SELECT ri.id AS return_item_id, oibc.id AS bundle_component_id,
            oibc.component_offer_id AS offer_id, oibc.product_name,
            (ri.received_quantity * oibc.quantity_per_bundle) AS quantity,
            pt.lot_tracking_enabled, pt.serial_tracking_enabled,
            ribs.serial_number_id
       FROM return_items ri
       JOIN return_requests rr ON rr.id = ri.return_request_id
       JOIN order_item_bundle_components oibc ON oibc.order_item_id = ri.order_item_id
       JOIN product_variants pv ON pv.id = oibc.component_variant_id
       JOIN products p ON p.id = pv.product_id
       JOIN product_types pt ON pt.id = p.product_type_id
       LEFT JOIN return_item_bundle_serials ribs ON ribs.return_item_id = ri.id
        AND ribs.bundle_component_id = oibc.id
      WHERE rr.tenant_id = ? AND rr.id = ?
        AND (pt.serial_tracking_enabled = 0 OR ribs.serial_number_id IS NOT NULL)
      ORDER BY ri.id, oibc.sort_order, ribs.created_at FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(returnId)]
  );
  return rows.map((row) => ({ returnItemId: bufferToUuid(row.return_item_id),
    bundleComponentId: bufferToUuid(row.bundle_component_id), offerId: bufferToUuid(row.offer_id),
    productName: row.product_name,
    quantity: row.serial_number_id ? 1 : number(row.quantity),
    lotTracking: Boolean(row.lot_tracking_enabled), serialTracking: Boolean(row.serial_tracking_enabled),
    serialId: row.serial_number_id ? bufferToUuid(row.serial_number_id) : null }));
}

export async function inspectReturnItem({ itemId, condition, disposition, notes, refundAmount, connection }) {
  await connection.execute(
    `UPDATE return_items SET item_condition = ?, disposition = ?, inspection_notes = ?,
       approved_quantity = received_quantity, refund_amount = ? WHERE id = ?`,
    [condition, disposition, notes || null, refundAmount, uuidToBuffer(itemId)]
  );
}

export async function findOrCreateBalance({ id, tenantId, warehouseId, offerId, connection }) {
  await connection.execute(
    `INSERT IGNORE INTO inventory_balances (id, tenant_id, warehouse_id, offer_id) VALUES (?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(tenantId), uuidToBuffer(warehouseId), uuidToBuffer(offerId)]
  );
  const [rows] = await connection.execute(
    "SELECT id FROM inventory_balances WHERE tenant_id = ? AND warehouse_id = ? AND offer_id = ? FOR UPDATE",
    [uuidToBuffer(tenantId), uuidToBuffer(warehouseId), uuidToBuffer(offerId)]
  );
  return bufferToUuid(rows[0].id);
}

export async function addReturnedStock({ tenantId, balanceId, quantity, quarantine, connection }) {
  await connection.execute(
    `UPDATE inventory_balances SET on_hand_quantity = on_hand_quantity + ?,
       quarantine_quantity = quarantine_quantity + ?, version = version + 1,
       last_movement_at = UTC_TIMESTAMP(6) WHERE tenant_id = ? AND id = ?`,
    [quantity, quarantine ? quantity : 0, uuidToBuffer(tenantId), uuidToBuffer(balanceId)]
  );
}

export async function upsertReturnLot({ lot, connection }) {
  await connection.execute(
    `INSERT INTO inventory_lots (id, tenant_id, inventory_balance_id, lot_number, received_at,
       on_hand_quantity, quarantine_quantity, status)
     VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6), ?, ?, 'ACTIVE')
     ON DUPLICATE KEY UPDATE on_hand_quantity = on_hand_quantity + VALUES(on_hand_quantity),
       quarantine_quantity = quarantine_quantity + VALUES(quarantine_quantity), version = version + 1`,
    [uuidToBuffer(lot.id), uuidToBuffer(lot.tenantId), uuidToBuffer(lot.balanceId), lot.number,
      lot.quantity, lot.quarantine ? lot.quantity : 0]
  );
  const [rows] = await connection.execute(
    "SELECT id FROM inventory_lots WHERE inventory_balance_id = ? AND lot_number = ?",
    [uuidToBuffer(lot.balanceId), lot.number]
  );
  return bufferToUuid(rows[0].id);
}

export async function updateReturnedSerial({ serialId, balanceId, lotId, status, connection }) {
  await connection.execute(
    "UPDATE serial_numbers SET inventory_balance_id = ?, inventory_lot_id = ?, status = ? WHERE id = ?",
    [uuidToBuffer(balanceId), lotId ? uuidToBuffer(lotId) : null, status, uuidToBuffer(serialId)]
  );
}

export async function markSerialDisposition({ serialId, status, connection }) {
  await connection.execute("UPDATE serial_numbers SET status = ? WHERE id = ?", [status, uuidToBuffer(serialId)]);
}

export async function insertStockLedger({ entry, connection }) {
  await connection.execute(
    `INSERT INTO stock_ledger_entries (id, tenant_id, inventory_balance_id, inventory_lot_id,
       serial_number_id, movement_type, quantity_delta, quarantine_delta, reference_type,
       reference_id, reason_code, notes, created_by)
     VALUES (?, ?, ?, ?, ?, 'RETURN_RECEIPT', ?, ?, 'RETURN', ?, ?, ?, ?)`,
    [uuidToBuffer(entry.id), uuidToBuffer(entry.tenantId), uuidToBuffer(entry.balanceId),
      entry.lotId ? uuidToBuffer(entry.lotId) : null, entry.serialId ? uuidToBuffer(entry.serialId) : null,
      entry.quantity, entry.quarantine ? entry.quantity : 0, uuidToBuffer(entry.returnId),
      entry.reasonCode, entry.notes || null, uuidToBuffer(entry.actorUserId)]
  );
}

export async function insertRefund({ refund, items, connection }) {
  await connection.execute(
    `INSERT INTO refunds (id, tenant_id, customer_order_id, refund_number, status, reason_code,
       requested_amount, refunded_amount, provider_reference, requested_by, approved_by,
       approved_at, completed_at, notes)
     VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), ?)`,
    [uuidToBuffer(refund.id), uuidToBuffer(refund.tenantId), uuidToBuffer(refund.orderId),
      refund.number, refund.reasonCode, refund.amount, refund.amount, refund.reference || null,
      uuidToBuffer(refund.actorUserId), uuidToBuffer(refund.actorUserId), refund.notes || null]
  );
  for (const item of items) {
    await connection.execute(
      `INSERT INTO refund_items (id, refund_id, order_item_id, quantity, item_amount, total_amount)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidToBuffer(item.id), uuidToBuffer(refund.id), uuidToBuffer(item.orderItemId),
        item.quantity, item.amount, item.amount]
    );
  }
  await connection.execute(
    `UPDATE customer_orders SET refunded_total = refunded_total + ?,
       payment_status = CASE WHEN refunded_total + ? >= grand_total THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
       version = version + 1 WHERE tenant_id = ? AND id = ?`,
    [refund.amount, refund.amount, uuidToBuffer(refund.tenantId), uuidToBuffer(refund.orderId)]
  );
}

export async function findExchangeContext({ tenantId, returnId, replacementOfferId, connection }) {
  const [rows] = await connection.execute(
    `SELECT rr.id AS return_id, rr.status AS return_status, rr.return_type, rr.receiving_warehouse_id,
            ri.order_item_id, ri.approved_quantity, oi.customer_order_id, oi.seller_order_id,
            oi.offer_id AS original_offer_id, oi.unit_price AS original_price, oi.product_name,
            original_pv.product_id, pt.vertical, original_so.merchant_id, co.store_id,
            replacement.id AS replacement_offer_id, replacement.variant_id AS replacement_variant_id,
            replacement_pv.name AS replacement_variant, replacement_pv.sku AS replacement_sku,
            price.sale_price AS replacement_price
       FROM return_requests rr JOIN return_items ri ON ri.return_request_id = rr.id
       JOIN order_items oi ON oi.id = ri.order_item_id JOIN seller_orders original_so ON original_so.id = oi.seller_order_id
       JOIN customer_orders co ON co.id = oi.customer_order_id
       JOIN product_variants original_pv ON original_pv.id = oi.variant_id
       JOIN products p ON p.id = original_pv.product_id JOIN product_types pt ON pt.id = p.product_type_id
       JOIN seller_offers replacement ON replacement.id = ? AND replacement.tenant_id = rr.tenant_id
        AND replacement.store_id = co.store_id AND replacement.merchant_id = original_so.merchant_id
       JOIN product_variants replacement_pv ON replacement_pv.id = replacement.variant_id
        AND replacement_pv.product_id = original_pv.product_id AND replacement_pv.id <> original_pv.id
       JOIN offer_prices price ON price.offer_id = replacement.id
        AND (price.starts_at IS NULL OR price.starts_at <= UTC_TIMESTAMP())
        AND (price.ends_at IS NULL OR price.ends_at > UTC_TIMESTAMP())
      WHERE rr.tenant_id = ? AND rr.id = ? LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(replacementOfferId), uuidToBuffer(tenantId), uuidToBuffer(returnId)]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return { returnId: bufferToUuid(row.return_id), returnStatus: row.return_status, returnType: row.return_type,
    warehouseId: bufferToUuid(row.receiving_warehouse_id), orderItemId: bufferToUuid(row.order_item_id),
    quantity: number(row.approved_quantity), orderId: bufferToUuid(row.customer_order_id),
    sellerOrderId: bufferToUuid(row.seller_order_id), originalPrice: number(row.original_price),
    productName: row.product_name, vertical: row.vertical, replacementOfferId: bufferToUuid(row.replacement_offer_id),
    replacementVariantId: bufferToUuid(row.replacement_variant_id), replacementVariant: row.replacement_variant,
    replacementSku: row.replacement_sku, replacementPrice: number(row.replacement_price) };
}

export async function findReplacementBalance({ tenantId, offerId, quantity, connection }) {
  const [rows] = await connection.execute(
    `SELECT id, warehouse_id FROM inventory_balances WHERE tenant_id = ? AND offer_id = ?
       AND on_hand_quantity - reserved_quantity - quarantine_quantity >= ?
       ORDER BY (on_hand_quantity - reserved_quantity - quarantine_quantity) DESC LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(offerId), quantity]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), warehouseId: bufferToUuid(rows[0].warehouse_id) } : null;
}

export async function insertExchange({ exchange, balanceId, connection }) {
  await connection.execute(
    `INSERT INTO exchanges (id, tenant_id, return_request_id, original_order_item_id,
       replacement_offer_id, quantity, price_difference, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    [uuidToBuffer(exchange.id), uuidToBuffer(exchange.tenantId), uuidToBuffer(exchange.returnId),
      uuidToBuffer(exchange.orderItemId), uuidToBuffer(exchange.replacementOfferId), exchange.quantity,
      exchange.priceDifference]
  );
  await connection.execute(
    `INSERT INTO stock_reservations (id, tenant_id, inventory_balance_id, reference_type,
       reference_id, quantity, status) VALUES (?, ?, ?, 'EXCHANGE', ?, ?, 'ACTIVE')`,
    [uuidToBuffer(exchange.reservationId), uuidToBuffer(exchange.tenantId), uuidToBuffer(balanceId),
      uuidToBuffer(exchange.id), exchange.quantity]
  );
  await connection.execute(
    "UPDATE inventory_balances SET reserved_quantity = reserved_quantity + ?, version = version + 1 WHERE id = ?",
    [exchange.quantity, uuidToBuffer(balanceId)]
  );
}

export async function findExchangeForUpdate({ tenantId, exchangeId, connection }) {
  const [rows] = await connection.execute(
    `SELECT e.*, rr.customer_order_id, rr.status AS return_status, oi.seller_order_id,
            so.variant_id, p.name AS product_name, pv.name AS variant_name, pv.sku,
            sr.id AS reservation_id, sr.inventory_balance_id
       FROM exchanges e JOIN return_requests rr ON rr.id = e.return_request_id
       JOIN order_items oi ON oi.id = e.original_order_item_id
       JOIN seller_offers so ON so.id = e.replacement_offer_id JOIN product_variants pv ON pv.id = so.variant_id
       JOIN products p ON p.id = pv.product_id
       JOIN stock_reservations sr ON sr.reference_type = 'EXCHANGE' AND sr.reference_id = e.id AND sr.status = 'ACTIVE'
      WHERE e.tenant_id = ? AND e.id = ? LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(exchangeId)]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return { id: bufferToUuid(row.id), returnId: bufferToUuid(row.return_request_id), status: row.status,
    returnStatus: row.return_status, orderId: bufferToUuid(row.customer_order_id),
    sellerOrderId: bufferToUuid(row.seller_order_id), offerId: bufferToUuid(row.replacement_offer_id),
    variantId: bufferToUuid(row.variant_id), quantity: number(row.quantity), productName: row.product_name,
    variantName: row.variant_name, sku: row.sku, reservationId: bufferToUuid(row.reservation_id),
    balanceId: bufferToUuid(row.inventory_balance_id), priceDifference: number(row.price_difference) };
}

export async function completeExchange({ exchange, replacementItemId, actorUserId, notes, ledgerId, connection }) {
  await connection.execute(
    `INSERT INTO order_items (id, tenant_id, customer_order_id, seller_order_id, offer_id, variant_id,
       product_name, variant_name, sku, quantity, unit_price, list_price, taxable_amount,
       line_total, product_snapshot, status)
     SELECT ?, e.tenant_id, rr.customer_order_id, oi.seller_order_id, e.replacement_offer_id,
       so.variant_id, p.name, pv.name, pv.sku, e.quantity, op.sale_price, op.list_price,
       op.sale_price * e.quantity, op.sale_price * e.quantity,
       JSON_OBJECT('exchangeFor', oi.sku, 'replacementSku', pv.sku), 'FULFILLED'
       FROM exchanges e JOIN return_requests rr ON rr.id = e.return_request_id
       JOIN order_items oi ON oi.id = e.original_order_item_id JOIN seller_offers so ON so.id = e.replacement_offer_id
       JOIN product_variants pv ON pv.id = so.variant_id JOIN products p ON p.id = pv.product_id
       JOIN offer_prices op ON op.offer_id = so.id AND (op.starts_at IS NULL OR op.starts_at <= UTC_TIMESTAMP())
        AND (op.ends_at IS NULL OR op.ends_at > UTC_TIMESTAMP()) WHERE e.id = ? LIMIT 1`,
    [uuidToBuffer(replacementItemId), uuidToBuffer(exchange.id)]
  );
  await connection.execute(
    `UPDATE inventory_balances SET on_hand_quantity = on_hand_quantity - ?,
       reserved_quantity = reserved_quantity - ?, version = version + 1,
       last_movement_at = UTC_TIMESTAMP(6) WHERE id = ?`,
    [exchange.quantity, exchange.quantity, uuidToBuffer(exchange.balanceId)]
  );
  await connection.execute("UPDATE stock_reservations SET status = 'CONSUMED', released_at = UTC_TIMESTAMP(6) WHERE id = ?", [uuidToBuffer(exchange.reservationId)]);
  await connection.execute(
    `INSERT INTO stock_ledger_entries (id, tenant_id, inventory_balance_id, movement_type,
       quantity_delta, reserved_delta, reference_type, reference_id, reason_code, notes, created_by)
     VALUES (?, ?, ?, 'EXCHANGE_ISSUE', ?, ?, 'EXCHANGE', ?, 'REPLACEMENT', ?, ?)`,
    [uuidToBuffer(ledgerId), uuidToBuffer(exchange.tenantId), uuidToBuffer(exchange.balanceId),
      -exchange.quantity, -exchange.quantity, uuidToBuffer(exchange.id), notes || null, uuidToBuffer(actorUserId)]
  );
  await connection.execute(
    `UPDATE exchanges SET status = 'COMPLETED', replacement_order_item_id = ?, completed_at = UTC_TIMESTAMP(6)
      WHERE tenant_id = ? AND id = ?`, [uuidToBuffer(replacementItemId), uuidToBuffer(exchange.tenantId), uuidToBuffer(exchange.id)]
  );
  await connection.execute(
    "UPDATE return_requests SET status = 'COMPLETED', completed_at = UTC_TIMESTAMP(6) WHERE tenant_id = ? AND id = ? AND status = 'INSPECTED'",
    [uuidToBuffer(exchange.tenantId), uuidToBuffer(exchange.returnId)]
  );
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(
    `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type,
       entity_id, request_id, ip_address, user_agent, before_data, after_data)
     VALUES (?, ?, ?, 'USER', ?, ?, ?, ?, INET6_ATON(?), ?, ?, ?)`,
    [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId),
      audit.action, audit.entityType, uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress,
      audit.userAgent, JSON.stringify(audit.beforeData), JSON.stringify(audit.afterData)]
  );
}
