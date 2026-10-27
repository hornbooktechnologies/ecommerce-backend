import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

const number = (value) => Number(value || 0);
const iso = (value) => value instanceof Date ? value.toISOString() : value;
const date = (value) => value ? String(iso(value)).slice(0, 10) : null;
const escapeSearch = (value) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

function json(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapCustomer(row) {
  return {
    id: bufferToUuid(row.id), number: row.customer_number,
    firstName: row.first_name, lastName: row.last_name || "",
    name: [row.first_name, row.last_name].filter(Boolean).join(" "),
    email: row.email || "", phone: row.phone || "", type: row.customer_type,
    companyName: row.company_name || "", gstin: row.gstin || "", status: row.status,
    notes: row.notes || "", orderCount: number(row.order_count),
    completedOrderCount: number(row.completed_order_count), totalSpent: number(row.total_spent),
    returnCount: number(row.return_count), warrantyCount: number(row.warranty_count),
    lastOrderAt: iso(row.last_order_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function mapAddress(row) {
  return {
    id: bufferToUuid(row.id), type: row.address_type, label: row.label || "",
    isDefault: Boolean(row.is_default), contactName: row.contact_name || "",
    companyName: row.company_name || "", line1: row.line1, line2: row.line2 || "",
    landmark: row.landmark || "", city: row.city, district: row.district || "",
    stateCode: row.state_code, stateName: row.state_name, postalCode: row.postal_code,
    countryCode: row.country_code, phone: row.phone || "", source: "SAVED"
  };
}

export async function listCustomers({ tenantId, filters, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const where = ["c.tenant_id = ?", "c.deleted_at IS NULL"];
  const parameters = [tenant];
  if (filters.search) {
    const term = `%${escapeSearch(filters.search)}%`;
    where.push(`(c.customer_number LIKE ? ESCAPE '\\\\' OR c.first_name LIKE ? ESCAPE '\\\\'
      OR c.last_name LIKE ? ESCAPE '\\\\' OR c.email LIKE ? ESCAPE '\\\\'
      OR c.phone LIKE ? ESCAPE '\\\\' OR c.company_name LIKE ? ESCAPE '\\\\'
      OR c.gstin LIKE ? ESCAPE '\\\\')`);
    parameters.push(term, term, term, term, term, term, term);
  }
  if (filters.status !== "ALL") { where.push("c.status = ?"); parameters.push(filters.status); }
  if (filters.type !== "ALL") { where.push("c.customer_type = ?"); parameters.push(filters.type); }
  const clause = where.join(" AND ");
  const offset = (filters.page - 1) * filters.pageSize;
  const [rowsResult, countResult, summaryResult] = await Promise.all([
    connection.execute(
      `SELECT c.*,
              (SELECT COUNT(*) FROM customer_orders co WHERE co.customer_id = c.id) AS order_count,
              (SELECT COUNT(*) FROM customer_orders co WHERE co.customer_id = c.id
                AND co.status = 'COMPLETED') AS completed_order_count,
              (SELECT COALESCE(SUM(co.grand_total), 0) FROM customer_orders co
                WHERE co.customer_id = c.id AND co.status = 'COMPLETED') AS total_spent,
              (SELECT MAX(COALESCE(co.placed_at, co.created_at)) FROM customer_orders co
                WHERE co.customer_id = c.id) AS last_order_at,
              (SELECT COUNT(*) FROM return_requests rr JOIN customer_orders co ON co.id = rr.customer_order_id
                WHERE co.customer_id = c.id) AS return_count,
              (SELECT COUNT(*) FROM warranty_registrations wr WHERE wr.customer_id = c.id) AS warranty_count
         FROM customers c WHERE ${clause}
        ORDER BY COALESCE(last_order_at, c.created_at) DESC, c.created_at DESC
        LIMIT ? OFFSET ?`, [...parameters, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total FROM customers c WHERE ${clause}`, parameters),
    connection.execute(
      `SELECT COUNT(*) AS total, SUM(c.status = 'ACTIVE') AS active,
              SUM(c.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)) AS new_30d,
              (SELECT COUNT(*) FROM (SELECT co.customer_id FROM customer_orders co
                WHERE co.tenant_id = ? AND co.customer_id IS NOT NULL
                GROUP BY co.customer_id HAVING COUNT(*) > 1) returning_customers) AS returning_count,
              (SELECT COALESCE(SUM(co.grand_total), 0) FROM customer_orders co
                WHERE co.tenant_id = ? AND co.status = 'COMPLETED') AS lifetime_revenue
         FROM customers c WHERE c.tenant_id = ? AND c.deleted_at IS NULL`, [tenant, tenant, tenant])
  ]);
  const total = number(countResult[0][0].total);
  const summary = summaryResult[0][0];
  return {
    items: rowsResult[0].map(mapCustomer), total, page: filters.page, pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
    summary: { total: number(summary.total), active: number(summary.active),
      new30d: number(summary.new_30d), returning: number(summary.returning_count),
      lifetimeRevenue: number(summary.lifetime_revenue) }
  };
}

export async function getCustomer({ tenantId, customerId, connection = getPrimaryPool(), forUpdate = false }) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.execute(
    `SELECT c.*,
            (SELECT COUNT(*) FROM customer_orders co WHERE co.customer_id = c.id) AS order_count,
            (SELECT COUNT(*) FROM customer_orders co WHERE co.customer_id = c.id
              AND co.status = 'COMPLETED') AS completed_order_count,
            (SELECT COALESCE(SUM(co.grand_total), 0) FROM customer_orders co
              WHERE co.customer_id = c.id AND co.status = 'COMPLETED') AS total_spent,
            (SELECT MAX(COALESCE(co.placed_at, co.created_at)) FROM customer_orders co
              WHERE co.customer_id = c.id) AS last_order_at,
            (SELECT COUNT(*) FROM return_requests rr JOIN customer_orders co ON co.id = rr.customer_order_id
              WHERE co.customer_id = c.id) AS return_count,
            (SELECT COUNT(*) FROM warranty_registrations wr WHERE wr.customer_id = c.id) AS warranty_count
       FROM customers c WHERE c.tenant_id = ? AND c.id = ? AND c.deleted_at IS NULL LIMIT 1${lock}`,
    [uuidToBuffer(tenantId), uuidToBuffer(customerId)]
  );
  return rows[0] ? mapCustomer(rows[0]) : null;
}

export async function getCustomerDetails({ tenantId, customerId, connection = getPrimaryPool() }) {
  const customer = await getCustomer({ tenantId, customerId, connection });
  if (!customer) return null;
  const tenant = uuidToBuffer(tenantId);
  const id = uuidToBuffer(customerId);
  const [addressResult, orderResult, returnResult, warrantyResult, recentAddressResult] = await Promise.all([
    connection.execute(
      `SELECT a.*, ca.address_type, ca.label, ca.is_default FROM customer_addresses ca
        JOIN addresses a ON a.id = ca.address_id
       WHERE ca.tenant_id = ? AND ca.customer_id = ? ORDER BY ca.is_default DESC, ca.created_at DESC`, [tenant, id]),
    connection.execute(
      `SELECT co.id, co.order_number, co.status, co.payment_status, co.fulfillment_status,
              co.grand_total, co.currency, co.placed_at, co.created_at, s.name AS store_name,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.customer_order_id = co.id) AS item_count
         FROM customer_orders co JOIN stores s ON s.id = co.store_id
        WHERE co.tenant_id = ? AND co.customer_id = ?
        ORDER BY COALESCE(co.placed_at, co.created_at) DESC LIMIT 20`, [tenant, id]),
    connection.execute(
      `SELECT rr.id, rr.return_number, rr.return_type, rr.status, rr.reason_code,
              rr.requested_at, rr.completed_at, co.order_number,
              COALESCE((SELECT SUM(ri.refund_amount) FROM return_items ri
                WHERE ri.return_request_id = rr.id), 0) AS refund_amount
         FROM return_requests rr JOIN customer_orders co ON co.id = rr.customer_order_id
        WHERE rr.tenant_id = ? AND co.customer_id = ? ORDER BY rr.requested_at DESC LIMIT 20`, [tenant, id]),
    connection.execute(
      `SELECT wr.id, wr.warranty_type, wr.starts_at, wr.ends_at,
              CASE WHEN wr.status = 'ACTIVE' AND wr.ends_at < UTC_DATE() THEN 'EXPIRED' ELSE wr.status END AS status,
              oi.product_name, oi.variant_name, oi.sku, co.order_number, sn.serial_number,
              (SELECT COUNT(*) FROM warranty_claims wc WHERE wc.warranty_registration_id = wr.id) AS claim_count
         FROM warranty_registrations wr JOIN order_items oi ON oi.id = wr.order_item_id
         JOIN customer_orders co ON co.id = oi.customer_order_id
         LEFT JOIN serial_numbers sn ON sn.id = wr.serial_number_id
        WHERE wr.tenant_id = ? AND wr.customer_id = ? ORDER BY wr.created_at DESC LIMIT 20`, [tenant, id]),
    connection.execute(
      `SELECT co.order_number, co.shipping_address_snapshot FROM customer_orders co
        WHERE co.tenant_id = ? AND co.customer_id = ?
        ORDER BY COALESCE(co.placed_at, co.created_at) DESC LIMIT 10`, [tenant, id])
  ]);
  const addresses = addressResult[0].map(mapAddress);
  const addressKeys = new Set(addresses.map((item) => `${item.line1}|${item.postalCode}`.toLowerCase()));
  for (const row of recentAddressResult[0]) {
    const address = json(row.shipping_address_snapshot);
    const key = `${address.line1 || ""}|${address.postalCode || ""}`.toLowerCase();
    if (!address.line1 || addressKeys.has(key)) continue;
    addressKeys.add(key);
    addresses.push({ ...address, id: null, type: "SHIPPING", label: "Recent delivery",
      isDefault: false, source: "ORDER", orderNumber: row.order_number });
  }
  return {
    customer, addresses,
    orders: orderResult[0].map((row) => ({ id: bufferToUuid(row.id), number: row.order_number,
      status: row.status, paymentStatus: row.payment_status, fulfillmentStatus: row.fulfillment_status,
      total: number(row.grand_total), currency: row.currency, storeName: row.store_name,
      itemCount: number(row.item_count), placedAt: iso(row.placed_at), createdAt: iso(row.created_at) })),
    returns: returnResult[0].map((row) => ({ id: bufferToUuid(row.id), number: row.return_number,
      type: row.return_type, status: row.status, reasonCode: row.reason_code,
      orderNumber: row.order_number, refundAmount: number(row.refund_amount),
      requestedAt: iso(row.requested_at), completedAt: iso(row.completed_at) })),
    warranties: warrantyResult[0].map((row) => ({ id: bufferToUuid(row.id), type: row.warranty_type,
      status: row.status, startsAt: date(row.starts_at), endsAt: date(row.ends_at),
      productName: row.product_name, variantName: row.variant_name, sku: row.sku,
      orderNumber: row.order_number, serialNumber: row.serial_number || "",
      claimCount: number(row.claim_count) }))
  };
}

export async function updateCustomer({ tenantId, customerId, input, connection }) {
  const [result] = await connection.execute(
    `UPDATE customers SET first_name = ?, last_name = ?, email = ?, phone = ?,
            customer_type = ?, company_name = ?, gstin = ?, status = ?, notes = ?
      WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
    [input.firstName, input.lastName || null, input.email || null, input.phone || null,
      input.type, input.companyName || null, input.gstin || null, input.status, input.notes || null,
      uuidToBuffer(tenantId), uuidToBuffer(customerId)]
  );
  if (input.status !== "ACTIVE") {
    await connection.execute("DELETE FROM customer_sessions WHERE tenant_id = ? AND customer_id = ?", [uuidToBuffer(tenantId), uuidToBuffer(customerId)]);
  }
  return result.affectedRows === 1;
}

export async function hasStorefrontAccount({ tenantId, customerId, connection }) {
  const [rows] = await connection.execute("SELECT customer_id FROM customer_accounts WHERE tenant_id = ? AND customer_id = ?", [uuidToBuffer(tenantId), uuidToBuffer(customerId)]);
  return rows.length > 0;
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(
    `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type,
       entity_id, request_id, ip_address, user_agent, before_data, after_data)
     VALUES (?, ?, ?, 'USER', ?, 'CUSTOMER', ?, ?, INET6_ATON(?), ?, ?, ?)`,
    [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId),
      audit.action, uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress,
      audit.userAgent, JSON.stringify(audit.beforeData), JSON.stringify(audit.afterData)]
  );
}
