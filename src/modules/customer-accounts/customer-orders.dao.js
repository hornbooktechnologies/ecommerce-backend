import { bufferToUuid, uuidToBuffer as id } from "../../core/identifiers/uuid.js";
import { getTaxDocumentDetail } from "../taxes/taxes.dao.js";
import { deliveredItemSql } from "./customer-reviews.dao.js";

const iso = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const json = (value) => { try { return typeof value === "string" ? JSON.parse(value) : value || {}; } catch { return {}; } };
const scopeSql = "o.tenant_id = ? AND o.store_id = ? AND o.customer_id = ? AND o.status <> 'DRAFT'";
const values = ({ tenantId, storeId, customerId }) => [id(tenantId), id(storeId), id(customerId)];
const invoiceScope = `${scopeSql} AND o.id = ? AND td.document_type = 'TAX_INVOICE' AND td.status = 'ISSUED'`;
const invoiceJoin = "FROM tax_documents td JOIN customer_orders o ON o.id = td.customer_order_id AND o.tenant_id = td.tenant_id";

export async function readInvoice(args) {
  const { connection, orderId, documentId } = args;
  const [[owned]] = await connection.execute(`SELECT td.id ${invoiceJoin} WHERE ${invoiceScope} AND td.id = ?`,
    [...values(args), id(orderId), id(documentId)]);
  if (!owned) return null;
  // Only resolve the full PDF data after all ownership and publication checks.
  return getTaxDocumentDetail({ tenantId: args.tenantId, documentId, connection });
}
const columns = `o.id, o.order_number, o.status, o.payment_status, o.payment_method, o.fulfillment_status, o.currency,
  (SELECT sc.id FROM storefront_checkouts sc WHERE sc.tenant_id = o.tenant_id AND sc.order_id = o.id LIMIT 1) AS checkout_id,
  o.subtotal, o.discount_total, o.shipping_total, o.tax_total, o.rounding_total, o.grand_total,
  o.refunded_total, o.placed_at, o.updated_at`;
const summary = (row) => ({ id: bufferToUuid(row.id), orderNumber: row.order_number, status: row.status,
  paymentStatus: row.payment_status, paymentMethod: row.payment_method || null, checkoutId: bufferToUuid(row.checkout_id), fulfillmentStatus: row.fulfillment_status, currency: row.currency,
  subtotal: Number(row.subtotal), discountTotal: Number(row.discount_total), shippingTotal: Number(row.shipping_total),
  taxTotal: Number(row.tax_total), roundingTotal: Number(row.rounding_total), grandTotal: Number(row.grand_total),
  refundedTotal: Number(row.refunded_total), placedAt: iso(row.placed_at), updatedAt: iso(row.updated_at) });

export async function listOrders(args) {
  const { connection, page = 1, pageSize = 10 } = args;
  const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM customer_orders o WHERE ${scopeSql}`, values(args));
  const [rows] = await connection.execute(`SELECT ${columns},
    (SELECT COUNT(*) FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.customer_order_id = o.id) AS item_count,
    (SELECT i.product_name FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.customer_order_id = o.id ORDER BY i.created_at, i.id LIMIT 1) AS first_item
    FROM customer_orders o WHERE ${scopeSql} ORDER BY o.placed_at DESC, o.id DESC LIMIT ? OFFSET ?`,
  [...values(args), pageSize, (page - 1) * pageSize]);
  return { items: rows.map((row) => ({ ...summary(row), itemCount: Number(row.item_count), firstItem: row.first_item })),
    pagination: { page, pageSize, total: Number(count.total), totalPages: Math.ceil(Number(count.total) / pageSize) } };
}

export async function readOrder(args) {
  const { connection, orderId } = args;
  const bindings = [...values(args), id(orderId)];
  const scope = `${scopeSql} AND o.id = ?`;
  const [[row]] = await connection.execute(`SELECT ${columns}, o.shipping_address_snapshot FROM customer_orders o WHERE ${scope}`, bindings);
  if (!row) return null;
  const [invoices] = await connection.execute(`SELECT td.id, td.document_number, td.document_date,
    td.grand_total, td.currency, m.display_name AS seller ${invoiceJoin}
    JOIN merchants m ON m.id = td.merchant_id AND m.tenant_id = td.tenant_id
    WHERE ${invoiceScope} ORDER BY td.document_date, td.id`, bindings);
  // Whitelist customer-facing columns. Never return internal notes, staff identities,
  // supplier information, warehouse details, or merchant payable amounts.
  const [items] = await connection.execute(`SELECT i.id, i.product_name, i.variant_name, i.sku, i.quantity,
    i.unit_price, i.line_total, i.status, m.display_name AS seller,
    (o.status NOT IN ('DRAFT', 'CANCELLED') AND i.status <> 'CANCELLED' AND ${deliveredItemSql}
      AND EXISTS (SELECT 1 FROM product_variants pv JOIN products p ON p.id = pv.product_id AND p.tenant_id = pv.tenant_id
        WHERE pv.id = i.variant_id AND pv.tenant_id = i.tenant_id AND p.deleted_at IS NULL)) AS review_eligible,
    pr.id AS review_id, IF(pr.deleted_at IS NULL, pr.status, 'HIDDEN') AS review_status
    FROM order_items i JOIN customer_orders o ON o.id = i.customer_order_id AND o.tenant_id = i.tenant_id
    JOIN seller_orders so ON so.id = i.seller_order_id AND so.tenant_id = i.tenant_id
    JOIN merchants m ON m.id = so.merchant_id AND m.tenant_id = so.tenant_id
    LEFT JOIN product_ratings pr ON pr.tenant_id = i.tenant_id AND pr.customer_id = o.customer_id AND pr.order_item_id = i.id
    WHERE ${scope} ORDER BY i.created_at, i.id`, bindings);
  const [history] = await connection.execute(`SELECT h.id, h.status_type, h.new_status, h.changed_at
    FROM order_status_history h JOIN customer_orders o ON o.id = h.customer_order_id AND o.tenant_id = h.tenant_id
    WHERE ${scope} AND h.status_type IN ('ORDER', 'PAYMENT', 'FULFILLMENT') ORDER BY h.changed_at DESC, h.id DESC`, bindings);
  const [fulfillments] = await connection.execute(`SELECT f.id, f.status, f.picking_started_at, f.packed_at,
    f.dispatched_at, f.completed_at, m.display_name AS seller, sh.id AS shipment_id,
    sh.provider_code, sh.tracking_number, sh.status AS shipment_status, sh.shipped_at, sh.delivered_at
    FROM fulfillments f JOIN seller_orders so ON so.id = f.seller_order_id AND so.tenant_id = f.tenant_id
    JOIN customer_orders o ON o.id = so.customer_order_id AND o.tenant_id = so.tenant_id
    JOIN merchants m ON m.id = so.merchant_id AND m.tenant_id = so.tenant_id
    LEFT JOIN shipments sh ON sh.fulfillment_id = f.id AND sh.tenant_id = f.tenant_id
    WHERE ${scope} ORDER BY f.created_at, f.id, sh.id`, bindings);
  const [slots] = await connection.execute(`SELECT s.starts_at, s.ends_at, r.status
    FROM delivery_slot_reservations r JOIN customer_orders o ON o.id = r.customer_order_id AND o.tenant_id = r.tenant_id
    JOIN delivery_slot_instances s ON s.id = r.delivery_slot_instance_id AND s.tenant_id = r.tenant_id
    WHERE ${scope} ORDER BY s.starts_at DESC LIMIT 1`, bindings);
  const address = json(row.shipping_address_snapshot);
  return { order: summary(row),
    invoices: invoices.map((entry) => ({ id: bufferToUuid(entry.id), number: entry.document_number,
      date: typeof entry.document_date === "string" ? entry.document_date.slice(0, 10) : iso(entry.document_date)?.slice(0, 10),
      total: Number(entry.grand_total), currency: entry.currency, seller: entry.seller })),
    address: Object.fromEntries(["contactName", "line1", "line2", "landmark", "city", "stateName", "postalCode", "countryCode"].map((key) => [key, address[key] || ""])),
    items: items.map((item) => ({ id: bufferToUuid(item.id), productName: item.product_name, variantName: item.variant_name,
      sku: item.sku, quantity: Number(item.quantity), unitPrice: Number(item.unit_price), lineTotal: Number(item.line_total), status: item.status, seller: item.seller,
      reviewEligible: Boolean(item.review_eligible), review: item.review_id ? { id: bufferToUuid(item.review_id), status: item.review_status } : null })),
    history: history.map((entry) => ({ id: bufferToUuid(entry.id), type: entry.status_type, status: entry.new_status, at: iso(entry.changed_at) })),
    fulfillments: fulfillments.map((entry) => ({ id: bufferToUuid(entry.id), shipmentId: bufferToUuid(entry.shipment_id), status: entry.status, seller: entry.seller,
      pickingAt: iso(entry.picking_started_at), packedAt: iso(entry.packed_at), dispatchedAt: iso(entry.dispatched_at), completedAt: iso(entry.completed_at),
      carrier: entry.provider_code, trackingNumber: entry.tracking_number, shipmentStatus: entry.shipment_status,
      shippedAt: iso(entry.shipped_at), deliveredAt: iso(entry.delivered_at) })),
    deliverySlot: slots[0] ? { startsAt: iso(slots[0].starts_at), endsAt: iso(slots[0].ends_at), status: slots[0].status } : null };
}
