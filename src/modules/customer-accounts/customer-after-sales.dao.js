import { bufferToUuid as uuid, uuidToBuffer as id } from "../../core/identifiers/uuid.js";

const scopeSql = "o.tenant_id = ? AND o.store_id = ? AND o.customer_id = ? AND o.id = ? AND o.status <> 'DRAFT'";
const values = (args) => [args.tenantId, args.storeId, args.customerId, args.orderId].map(id);
const iso = (value) => value ? new Date(value).toISOString() : null;

export async function ownedOrder(args) {
  const [[row]] = await args.connection.execute(`SELECT o.id, o.status, o.payment_status FROM customer_orders o
    WHERE ${scopeSql}${args.lock ? " FOR UPDATE" : ""}`, values(args));
  return row ? { id: uuid(row.id), status: row.status, paymentStatus: row.payment_status } : null;
}

export async function items(args) {
  const [rows] = await args.connection.execute(`SELECT i.id, i.product_name, i.variant_name, i.quantity, i.status,
    p.is_returnable, p.return_window_days, pt.vertical, pv.sold_by_weight,
    (SELECT MAX(f.completed_at) FROM fulfillment_items fi JOIN fulfillments f ON f.id = fi.fulfillment_id
      WHERE fi.order_item_id = i.id AND f.tenant_id = i.tenant_id AND f.status = 'COMPLETED') AS delivered_at,
    UTC_TIMESTAMP(6) AS checked_at
    FROM order_items i JOIN customer_orders o ON o.id = i.customer_order_id AND o.tenant_id = i.tenant_id
    LEFT JOIN product_variants pv ON pv.id = i.variant_id AND pv.tenant_id = i.tenant_id
    LEFT JOIN products p ON p.id = pv.product_id AND p.tenant_id = i.tenant_id
    LEFT JOIN product_types pt ON pt.id = p.product_type_id
    WHERE ${scopeSql} ORDER BY i.id${args.lock ? " FOR UPDATE" : ""}`, values(args));
  return rows.map((row) => ({ id: uuid(row.id), name: row.product_name, variant: row.variant_name || "",
    quantity: Number(row.quantity), status: row.status, returnable: Boolean(row.is_returnable),
    windowDays: row.return_window_days === null ? null : Number(row.return_window_days), vertical: row.vertical,
    fractional: Boolean(row.sold_by_weight), deliveredAt: iso(row.delivered_at), checkedAt: iso(row.checked_at) }));
}

export async function cases(args) {
  const [rows] = await args.connection.execute(`SELECT rr.id, rr.return_number, rr.return_type, rr.status, rr.reason_code,
    rr.requested_at, rr.approved_at, rr.received_at, rr.completed_at,
    ri.order_item_id, ri.requested_quantity, ri.serial_number_id, oi.product_name,
    e.status AS exchange_status, pv.name AS replacement_variant, pv.sku AS replacement_sku
    FROM return_requests rr JOIN customer_orders o ON o.id = rr.customer_order_id AND o.tenant_id = rr.tenant_id
    JOIN return_items ri ON ri.return_request_id = rr.id
    JOIN order_items oi ON oi.id = ri.order_item_id AND oi.tenant_id = rr.tenant_id
    LEFT JOIN exchanges e ON e.return_request_id = rr.id AND e.tenant_id = rr.tenant_id
    LEFT JOIN seller_offers so ON so.id = e.replacement_offer_id AND so.tenant_id = rr.tenant_id
    LEFT JOIN product_variants pv ON pv.id = so.variant_id AND pv.tenant_id = rr.tenant_id
    WHERE ${scopeSql} ORDER BY rr.requested_at DESC, rr.id, ri.id${args.lock ? " FOR UPDATE" : ""}`, values(args));
  const result = new Map();
  for (const row of rows) {
    const key = uuid(row.id);
    if (!result.has(key)) result.set(key, { id: key, number: row.return_number, type: row.return_type, status: row.status,
      reason: row.reason_code, requestedAt: iso(row.requested_at), approvedAt: iso(row.approved_at),
      receivedAt: iso(row.received_at), completedAt: iso(row.completed_at),
      exchange: row.exchange_status ? { status: row.exchange_status, variant: row.replacement_variant, sku: row.replacement_sku } : null, items: [] });
    result.get(key).items.push({ orderItemId: uuid(row.order_item_id), name: row.product_name,
      quantity: Number(row.requested_quantity), serialId: uuid(row.serial_number_id) });
  }
  return [...result.values()];
}

export async function serials(args) {
  const [rows] = await args.connection.execute(`SELECT DISTINCT i.id AS order_item_id, sn.id, sn.serial_number
    FROM order_items i JOIN customer_orders o ON o.id = i.customer_order_id AND o.tenant_id = i.tenant_id
    JOIN fulfillment_items fi ON fi.order_item_id = i.id
    JOIN fulfillments f ON f.id = fi.fulfillment_id AND f.tenant_id = i.tenant_id AND f.status = 'COMPLETED'
    JOIN fulfillment_item_serials fis ON fis.fulfillment_item_id = fi.id
    JOIN serial_numbers sn ON sn.id = fis.serial_number_id AND sn.tenant_id = i.tenant_id
    WHERE ${scopeSql} AND sn.status = 'SOLD'${args.lock ? " FOR UPDATE" : ""}`, values(args));
  // Bundle serials are linked separately from ordinary serialized return items.
  const [used] = await args.connection.execute(`SELECT rbs.serial_number_id FROM return_item_bundle_serials rbs
    JOIN return_items ri ON ri.id = rbs.return_item_id JOIN return_requests rr ON rr.id = ri.return_request_id
    JOIN customer_orders o ON o.id = rr.customer_order_id AND o.tenant_id = rr.tenant_id
    WHERE ${scopeSql} AND rr.status <> 'REJECTED'${args.lock ? " FOR UPDATE" : ""}`, values(args));
  const reserved = new Set(used.map((row) => uuid(row.serial_number_id)));
  return rows.filter((row) => !reserved.has(uuid(row.id))).map((row) => ({ id: uuid(row.id), number: row.serial_number, orderItemId: uuid(row.order_item_id) }));
}

export async function receipt({ tenantId, key, connection }) {
  const [[row]] = await connection.execute(`SELECT request_hash, response_body FROM idempotency_keys
    WHERE tenant_id = ? AND operation = 'CUSTOMER_RETURN' AND idempotency_key = ? FOR UPDATE`, [id(tenantId), key]);
  return row ? { hash: row.request_hash, body: typeof row.response_body === "string" ? JSON.parse(row.response_body) : row.response_body } : null;
}

export async function saveReceipt({ tenantId, receiptId, key, hash, body, connection }) {
  await connection.execute(`INSERT INTO idempotency_keys (id, tenant_id, operation, idempotency_key, request_hash,
    status, response_status, response_body, expires_at) VALUES (?, ?, 'CUSTOMER_RETURN', ?, ?, 'COMPLETED', 200, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 DAY))`,
  [id(receiptId), id(tenantId), key, hash, JSON.stringify(body)]);
}

export async function audit({ tenantId, customerId, entityId, entityType, action, afterData, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_type, action, entity_type, entity_id, after_data)
    VALUES (UNHEX(REPLACE(UUID(), '-', '')), ?, 'CUSTOMER', ?, ?, ?, ?)`,
  [id(tenantId), action, entityType, id(entityId), JSON.stringify({ ...afterData, customerId })]);
}
