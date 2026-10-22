import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

const number = (value) => value === null || value === undefined ? null : Number(value);
const iso = (value) => value ? new Date(value).toISOString() : null;
const escapeSearch = (value) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

function mapSupplier(row) {
  return { id: bufferToUuid(row.id), code: row.supplier_code, legalName: row.legal_name,
    displayName: row.display_name, gstin: row.gstin, pan: row.pan, contactName: row.contact_name,
    email: row.email, phone: row.phone, status: row.status,
    paymentTermsDays: number(row.payment_terms_days), openPurchaseOrders: Number(row.open_purchase_orders || 0),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function mapPurchaseOrder(row) {
  return { id: bufferToUuid(row.id), number: row.purchase_order_number,
    supplierId: bufferToUuid(row.supplier_id), supplierName: row.supplier_name,
    supplierCode: row.supplier_code, warehouseId: bufferToUuid(row.warehouse_id),
    warehouseName: row.warehouse_name, status: row.status, currency: row.currency,
    subtotal: number(row.subtotal), taxTotal: number(row.tax_total), grandTotal: number(row.grand_total),
    expectedAt: row.expected_at ? iso(row.expected_at).slice(0, 10) : null, notes: row.notes,
    itemCount: Number(row.item_count || 0), orderedQuantity: number(row.ordered_quantity) || 0,
    receivedQuantity: number(row.received_quantity) || 0, approvedAt: iso(row.approved_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

const supplierSelect = `SELECT s.*,
  (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id
    AND po.status IN ('DRAFT','APPROVED','PARTIALLY_RECEIVED')) AS open_purchase_orders
  FROM suppliers s`;

const orderSelect = `SELECT po.*, s.display_name AS supplier_name, s.supplier_code,
  w.name AS warehouse_name, COUNT(poi.id) AS item_count,
  COALESCE(SUM(poi.ordered_quantity), 0) AS ordered_quantity,
  COALESCE(SUM(poi.received_quantity), 0) AS received_quantity
  FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
  JOIN warehouses w ON w.id = po.warehouse_id
  LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id`;

export async function listSuppliers({ tenantId, filters, connection = getPrimaryPool() }) {
  const where = ["s.tenant_id = ?", "s.deleted_at IS NULL"]; const params = [uuidToBuffer(tenantId)];
  if (filters.search) { const term = `%${escapeSearch(filters.search)}%`;
    where.push("(s.display_name LIKE ? ESCAPE '\\\\' OR s.legal_name LIKE ? ESCAPE '\\\\' OR s.supplier_code LIKE ? ESCAPE '\\\\' OR s.gstin LIKE ? ESCAPE '\\\\')");
    params.push(term, term, term, term); }
  if (filters.status !== "ALL") { where.push("s.status = ?"); params.push(filters.status); }
  const clause = where.join(" AND "); const offset = (filters.page - 1) * filters.pageSize;
  const [[rows], [countRows]] = await Promise.all([
    connection.execute(`${supplierSelect} WHERE ${clause} ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`,
      [...params, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total FROM suppliers s WHERE ${clause}`, params)
  ]);
  const total = Number(countRows[0].total || 0);
  return { items: rows.map(mapSupplier), total, page: filters.page, pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)) };
}

export async function findSupplier({ tenantId, supplierId, connection = getPrimaryPool(), forUpdate = false }) {
  if (forUpdate) {
    const [locked] = await connection.execute("SELECT id FROM suppliers WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE",
      [uuidToBuffer(tenantId), uuidToBuffer(supplierId)]);
    if (!locked[0]) return null;
  }
  const [rows] = await connection.execute(`${supplierSelect} WHERE s.tenant_id = ? AND s.id = ?
    AND s.deleted_at IS NULL LIMIT 1`,
  [uuidToBuffer(tenantId), uuidToBuffer(supplierId)]);
  return rows[0] ? mapSupplier(rows[0]) : null;
}

export async function insertSupplier({ supplier, connection }) {
  await connection.execute(`INSERT INTO suppliers (id, tenant_id, supplier_code, legal_name, display_name,
    gstin, pan, contact_name, email, phone, status, payment_terms_days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [uuidToBuffer(supplier.id), uuidToBuffer(supplier.tenantId), supplier.code, supplier.legalName,
    supplier.displayName, supplier.gstin || null, supplier.pan || null, supplier.contactName || null,
    supplier.email || null, supplier.phone || null, supplier.status, supplier.paymentTermsDays]);
}

export async function updateSupplier({ supplierId, input, connection }) {
  await connection.execute(`UPDATE suppliers SET supplier_code = ?, legal_name = ?, display_name = ?,
    gstin = ?, pan = ?, contact_name = ?, email = ?, phone = ?, status = ?, payment_terms_days = ? WHERE id = ?`,
  [input.code, input.legalName, input.displayName, input.gstin || null, input.pan || null,
    input.contactName || null, input.email || null, input.phone || null, input.status,
    input.paymentTermsDays, uuidToBuffer(supplierId)]);
}

export async function listPurchaseOrders({ tenantId, filters, connection = getPrimaryPool() }) {
  const where = ["po.tenant_id = ?"]; const params = [uuidToBuffer(tenantId)];
  if (filters.search) { const term = `%${escapeSearch(filters.search)}%`;
    where.push("(po.purchase_order_number LIKE ? ESCAPE '\\\\' OR s.display_name LIKE ? ESCAPE '\\\\' OR w.name LIKE ? ESCAPE '\\\\')");
    params.push(term, term, term); }
  if (filters.status !== "ALL") { where.push("po.status = ?"); params.push(filters.status); }
  const clause = where.join(" AND "); const offset = (filters.page - 1) * filters.pageSize;
  const [[rows], [countRows], [summaryRows]] = await Promise.all([
    connection.execute(`${orderSelect} WHERE ${clause} GROUP BY po.id
      ORDER BY po.created_at DESC LIMIT ? OFFSET ?`, [...params, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      JOIN warehouses w ON w.id = po.warehouse_id WHERE ${clause}`, params),
    connection.execute(`SELECT COUNT(*) AS total, SUM(status = 'DRAFT') AS draft,
      SUM(status = 'APPROVED') AS approved, SUM(status = 'PARTIALLY_RECEIVED') AS partial,
      SUM(status = 'RECEIVED') AS received, COALESCE(SUM(CASE WHEN status IN
      ('APPROVED','PARTIALLY_RECEIVED') THEN grand_total ELSE 0 END), 0) AS open_value
      FROM purchase_orders WHERE tenant_id = ?`, [uuidToBuffer(tenantId)])
  ]);
  const total = Number(countRows[0].total || 0); const summary = summaryRows[0];
  return { items: rows.map(mapPurchaseOrder), total, page: filters.page, pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)), summary: {
      total: Number(summary.total || 0), draft: Number(summary.draft || 0),
      approved: Number(summary.approved || 0), partial: Number(summary.partial || 0),
      received: Number(summary.received || 0), openValue: number(summary.open_value) || 0 } };
}

export async function findPurchaseOrder({ tenantId, purchaseOrderId, connection = getPrimaryPool(), forUpdate = false }) {
  if (forUpdate) {
    const [locked] = await connection.execute("SELECT id FROM purchase_orders WHERE tenant_id = ? AND id = ? FOR UPDATE",
      [uuidToBuffer(tenantId), uuidToBuffer(purchaseOrderId)]);
    if (!locked[0]) return null;
  }
  const [rows] = await connection.execute(`${orderSelect} WHERE po.tenant_id = ? AND po.id = ?
    GROUP BY po.id LIMIT 1`,
  [uuidToBuffer(tenantId), uuidToBuffer(purchaseOrderId)]);
  if (!rows[0]) return null;
  const order = mapPurchaseOrder(rows[0]);
  const [itemRows] = await connection.execute(`SELECT poi.*, p.name AS product_name, pv.name AS variant_name,
    pv.sku, pt.vertical, pt.lot_tracking_enabled, pt.serial_tracking_enabled, pt.expiry_tracking_enabled
    FROM purchase_order_items poi JOIN seller_offers so ON so.id = poi.offer_id
    JOIN product_variants pv ON pv.id = so.variant_id JOIN products p ON p.id = pv.product_id
    JOIN product_types pt ON pt.id = p.product_type_id WHERE poi.purchase_order_id = ? ORDER BY p.name, pv.name`,
  [uuidToBuffer(purchaseOrderId)]);
  order.items = itemRows.map((row) => ({ id: bufferToUuid(row.id), offerId: bufferToUuid(row.offer_id),
    productName: row.product_name, variantName: row.variant_name, sku: row.sku, vertical: row.vertical,
    orderedQuantity: number(row.ordered_quantity), receivedQuantity: number(row.received_quantity),
    remainingQuantity: number(row.ordered_quantity) - number(row.received_quantity), unitCost: number(row.unit_cost),
    taxRate: number(row.tax_rate), taxAmount: number(row.tax_amount), lineTotal: number(row.line_total),
    lotTrackingEnabled: Boolean(row.lot_tracking_enabled), serialTrackingEnabled: Boolean(row.serial_tracking_enabled),
    expiryTrackingEnabled: Boolean(row.expiry_tracking_enabled) }));
  return order;
}

export async function listOptions({ tenantId, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const [[suppliers], [warehouses], [offers]] = await Promise.all([
    connection.execute(`SELECT id, supplier_code, display_name, payment_terms_days FROM suppliers
      WHERE tenant_id = ? AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY display_name`, [tenant]),
    connection.execute(`SELECT id, merchant_id, code, name FROM warehouses WHERE tenant_id = ?
      AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY name`, [tenant]),
    connection.execute(`SELECT so.id, so.merchant_id, p.name AS product_name, pv.name AS variant_name,
      pv.sku, COALESCE(op.cost_price, op.sale_price, 0) AS unit_cost, pt.vertical,
      pt.lot_tracking_enabled, pt.serial_tracking_enabled, pt.expiry_tracking_enabled
      FROM seller_offers so JOIN product_variants pv ON pv.id = so.variant_id
      JOIN products p ON p.id = pv.product_id JOIN product_types pt ON pt.id = p.product_type_id
      LEFT JOIN offer_prices op ON op.id = (SELECT x.id FROM offer_prices x WHERE x.offer_id = so.id
        AND x.ends_at IS NULL ORDER BY x.starts_at DESC, x.created_at DESC LIMIT 1)
      WHERE so.tenant_id = ? AND so.status = 'ACTIVE' AND so.deleted_at IS NULL
      ORDER BY p.name, pv.name`, [tenant])
  ]);
  return { suppliers: suppliers.map((row) => ({ id: bufferToUuid(row.id), code: row.supplier_code,
    name: row.display_name, paymentTermsDays: number(row.payment_terms_days) })),
    warehouses: warehouses.map((row) => ({ id: bufferToUuid(row.id), merchantId: bufferToUuid(row.merchant_id),
      code: row.code, name: row.name })), offers: offers.map((row) => ({ id: bufferToUuid(row.id),
      merchantId: bufferToUuid(row.merchant_id), productName: row.product_name, variantName: row.variant_name,
      sku: row.sku, unitCost: number(row.unit_cost), vertical: row.vertical,
      lotTrackingEnabled: Boolean(row.lot_tracking_enabled), serialTrackingEnabled: Boolean(row.serial_tracking_enabled),
      expiryTrackingEnabled: Boolean(row.expiry_tracking_enabled) })) };
}

export async function insertPurchaseOrder({ order, connection }) {
  await connection.execute(`INSERT INTO purchase_orders (id, tenant_id, purchase_order_number, supplier_id,
    warehouse_id, status, currency, subtotal, tax_total, grand_total, expected_at, notes, created_by)
    VALUES (?, ?, ?, ?, ?, 'DRAFT', 'INR', ?, ?, ?, ?, ?, ?)`,
  [uuidToBuffer(order.id), uuidToBuffer(order.tenantId), order.number, uuidToBuffer(order.supplierId),
    uuidToBuffer(order.warehouseId), order.subtotal, order.taxTotal, order.grandTotal,
    order.expectedAt || null, order.notes || null, uuidToBuffer(order.actorUserId)]);
}

export async function insertPurchaseOrderItem({ item, connection }) {
  await connection.execute(`INSERT INTO purchase_order_items (id, purchase_order_id, offer_id,
    ordered_quantity, unit_cost, tax_rate, tax_amount, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [uuidToBuffer(item.id), uuidToBuffer(item.purchaseOrderId), uuidToBuffer(item.offerId),
    item.quantity, item.unitCost, item.taxRate, item.taxAmount, item.lineTotal]);
}

export async function findOrderScope({ tenantId, supplierId, warehouseId, offerIds, connection }) {
  const [supplierRows] = await connection.execute(`SELECT id FROM suppliers WHERE tenant_id = ? AND id = ?
    AND status = 'ACTIVE' AND deleted_at IS NULL`, [uuidToBuffer(tenantId), uuidToBuffer(supplierId)]);
  const [warehouseRows] = await connection.execute(`SELECT id, merchant_id FROM warehouses WHERE tenant_id = ?
    AND id = ? AND status = 'ACTIVE' AND deleted_at IS NULL`, [uuidToBuffer(tenantId), uuidToBuffer(warehouseId)]);
  if (!supplierRows[0] || !warehouseRows[0]) return null;
  const placeholders = offerIds.map(() => "?").join(", ");
  const [offerRows] = await connection.execute(`SELECT id FROM seller_offers WHERE tenant_id = ?
    AND merchant_id = ? AND status = 'ACTIVE' AND deleted_at IS NULL AND id IN (${placeholders})`,
  [uuidToBuffer(tenantId), warehouseRows[0].merchant_id, ...offerIds.map(uuidToBuffer)]);
  return { validOfferIds: offerRows.map((row) => bufferToUuid(row.id)) };
}

export async function transitionPurchaseOrder({ purchaseOrderId, action, actorUserId, connection }) {
  if (action === "approve") await connection.execute(`UPDATE purchase_orders SET status = 'APPROVED',
    approved_by = ?, approved_at = UTC_TIMESTAMP(6) WHERE id = ?`, [uuidToBuffer(actorUserId), uuidToBuffer(purchaseOrderId)]);
  else await connection.execute(`UPDATE purchase_orders SET status = 'CANCELLED' WHERE id = ?`, [uuidToBuffer(purchaseOrderId)]);
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action,
    entity_type, entity_id, request_id, ip_address, user_agent, before_data, after_data)
    VALUES (?, ?, ?, 'USER', ?, ?, ?, ?, INET6_ATON(?), ?, ?, ?)`,
  [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId), audit.action,
    audit.entityType, uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress || "127.0.0.1",
    audit.userAgent, JSON.stringify(audit.beforeData), JSON.stringify(audit.afterData)]);
}

export async function insertOutbox({ event, connection }) {
  await connection.execute(`INSERT INTO outbox_events (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
    VALUES (?, ?, ?, ?, ?, ?)`, [uuidToBuffer(event.id), uuidToBuffer(event.tenantId), event.aggregateType,
    uuidToBuffer(event.aggregateId), event.type, JSON.stringify(event.payload)]);
}
