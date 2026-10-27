import { uuidToBuffer as id, bufferToUuid } from "../../core/identifiers/uuid.js";
import { states } from "../customer-accounts/customer-accounts.validators.js";
const json = (value) => typeof value === "string" ? JSON.parse(value) : value;

const text = (value) => typeof value === "string" ? value.trim() : "";
const addressKey = (address) => JSON.stringify(["contactName", "line1", "line2", "landmark", "city", "stateCode", "postalCode"].map((key) => text(address[key]).toLowerCase().replace(/\s+/g, " "))
  .concat(text(address.phone).replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "")));

export async function previousAddresses({ tenantId, storeId, customerId, savedAddresses = [], connection }) {
  const [rows] = await connection.execute(`SELECT id, order_number, shipping_address_snapshot, customer_snapshot
    FROM customer_orders WHERE tenant_id = ? AND store_id = ? AND customer_id = ? AND status <> 'DRAFT'
    ORDER BY COALESCE(placed_at, created_at) DESC, id DESC LIMIT 50`, [id(tenantId), id(storeId), id(customerId)]);
  const seen = new Set(savedAddresses.map(addressKey)), result = [];
  for (const row of rows) {
    let shipping, customer;
    try { shipping = json(row.shipping_address_snapshot) || {}; customer = json(row.customer_snapshot) || {}; } catch { continue; }
    if (!text(shipping.line1) || (shipping.countryCode && shipping.countryCode !== "IN")) continue;
    const stateCode = states[text(shipping.stateCode).toUpperCase()] ? text(shipping.stateCode).toUpperCase()
      : Object.keys(states).find((code) => states[code].toLowerCase() === text(shipping.stateName).toLowerCase()) || "";
    const address = { contactName: text(shipping.contactName) || text(customer.name) || [text(customer.firstName), text(customer.lastName)].filter(Boolean).join(" "),
      phone: text(shipping.phone) || text(customer.phone), line1: text(shipping.line1), line2: text(shipping.line2), landmark: text(shipping.landmark),
      city: text(shipping.city), stateCode, stateName: states[stateCode] || text(shipping.stateName), postalCode: text(shipping.postalCode), countryCode: "IN" };
    const key = addressKey(address);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...address, orderId: bufferToUuid(row.id), orderNumber: row.order_number });
    if (result.length === 10) break;
  }
  return result;
}

export async function couponPromotion({ tenantId, couponCode, connection }) {
  const [[row]] = await connection.execute("SELECT promotion_id FROM coupons WHERE tenant_id = ? AND code = ? AND status = 'ACTIVE' LIMIT 1", [id(tenantId), couponCode]);
  return row ? bufferToUuid(row.promotion_id) : null;
}

// Called after the promotion row is locked. A current locking read avoids stale
// usage counts from a transaction snapshot established before another checkout.
export async function redemptionCounts({ tenantId, promotionId, customerId, connection }) {
  const [rows] = await connection.execute(`SELECT customer_id FROM promotion_redemptions
    WHERE tenant_id = ? AND promotion_id = ? AND reversed_at IS NULL FOR UPDATE`, [id(tenantId), id(promotionId)]);
  return { redemptionCount: rows.length, customerRedemptionCount: rows.filter((row) => bufferToUuid(row.customer_id) === customerId).length };
}

export async function slots({ tenantId, storeId, postalCode, slotId, connection, lock = false }) {
  const [rows] = await connection.execute(`SELECT s.id, s.starts_at, s.ends_at, s.order_capacity, s.reserved_orders,
    s.weight_capacity, s.reserved_weight, z.id AS zone_id, z.name, z.delivery_fee, z.minimum_order_amount, z.free_delivery_threshold
    FROM delivery_slot_instances s JOIN delivery_zones z ON z.id = s.delivery_zone_id AND z.tenant_id = s.tenant_id
    JOIN delivery_slot_templates t ON t.id = s.template_id AND t.tenant_id = s.tenant_id AND t.delivery_zone_id = z.id
    WHERE s.tenant_id = ? AND z.store_id = ? AND s.status = 'OPEN' AND z.status = 'ACTIVE' AND t.status = 'ACTIVE'
    AND s.starts_at > DATE_ADD(UTC_TIMESTAMP(6), INTERVAL t.cutoff_minutes MINUTE)
    AND s.starts_at < DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 DAY) AND s.ends_at > s.starts_at
    AND s.reserved_orders < s.order_capacity
    AND (s.weight_capacity IS NULL OR s.reserved_weight < s.weight_capacity)
    AND (NOT EXISTS(SELECT 1 FROM delivery_zone_postal_codes p WHERE p.delivery_zone_id = z.id AND p.status = 'ACTIVE')
      OR EXISTS(SELECT 1 FROM delivery_zone_postal_codes p WHERE p.delivery_zone_id = z.id AND p.status = 'ACTIVE' AND p.postal_code = ?))
    ${slotId ? "AND s.id = ?" : ""} ORDER BY s.starts_at, s.id LIMIT 100${lock ? " FOR UPDATE" : ""}`,
  [id(tenantId), id(storeId), postalCode, ...(slotId ? [id(slotId)] : [])]);
  return rows.map((row) => ({ id: bufferToUuid(row.id), zoneId: bufferToUuid(row.zone_id), name: row.name,
    startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(),
    orderCapacity: Number(row.order_capacity), reservedOrders: Number(row.reserved_orders),
    weightCapacity: row.weight_capacity === null ? null : Number(row.weight_capacity), reservedWeight: Number(row.reserved_weight),
    deliveryFee: Number(row.delivery_fee), minimumOrderAmount: Number(row.minimum_order_amount || 0),
    freeDeliveryThreshold: row.free_delivery_threshold === null ? null : Number(row.free_delivery_threshold),
    postalSupported: true, hasPostalRules: true }));
}

export async function insertQuote({ quoteId, tenantId, storeId, customerId, revision, quote, connection }) {
  await connection.execute(`INSERT INTO storefront_checkouts (id, tenant_id, store_id, customer_id, cart_revision, quote_json, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 15 MINUTE))`,
  [id(quoteId), id(tenantId), id(storeId), id(customerId), revision, JSON.stringify(quote)]);
}
export async function readQuote({ quoteId, tenantId, storeId, customerId, connection }) {
  const [[row]] = await connection.execute(`SELECT cart_revision, quote_json, receipt_json, order_id,
    expires_at <= UTC_TIMESTAMP(6) AS expired, expires_at FROM storefront_checkouts
    WHERE id = ? AND tenant_id = ? AND store_id = ? AND customer_id = ? FOR UPDATE`, [id(quoteId), id(tenantId), id(storeId), id(customerId)]);
  return row ? { revision: row.cart_revision, quote: json(row.quote_json), receipt: json(row.receipt_json),
    orderId: bufferToUuid(row.order_id), expired: Boolean(row.expired), expiresAt: new Date(row.expires_at).toISOString() } : null;
}
export async function complete({ quoteId, tenantId, storeId, customerId, receipt, connection }) {
  await connection.execute(`UPDATE storefront_checkouts SET order_id = ?, receipt_json = ?
    WHERE id = ? AND tenant_id = ? AND store_id = ? AND customer_id = ? AND order_id IS NULL`,
  [id(receipt.id), JSON.stringify(receipt), id(quoteId), id(tenantId), id(storeId), id(customerId)]);
}
