import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

const number = (value) => value === null || value === undefined ? null : Number(value);
const iso = (value) => value ? new Date(value).toISOString() : null;
function json(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function escapeSearch(value) { return value.replace(/[\\%_]/g, (character) => `\\${character}`); }

function mapSellerOrder(row) {
  return { id: bufferToUuid(row.id), number: row.seller_order_number,
    customerOrderId: bufferToUuid(row.customer_order_id), orderNumber: row.order_number,
    status: row.status, fulfillmentStatus: row.fulfillment_status,
    paymentStatus: row.payment_status, paymentAllocationStatus: row.payment_allocation_status,
    currency: row.currency, subtotal: number(row.subtotal), discountTotal: number(row.discount_total),
    shippingTotal: number(row.shipping_total), taxTotal: number(row.tax_total),
    grandTotal: number(row.grand_total), merchantPayableTotal: number(row.merchant_payable_total),
    customerName: row.customer_name || "Guest customer", customerEmail: row.customer_email,
    customerPhone: row.customer_phone, storeName: row.store_name,
    itemCount: Number(row.item_count || 0), totalQuantity: number(row.total_quantity) || 0,
    primaryItemName: row.primary_item_name, placedAt: iso(row.placed_at),
    acceptedAt: iso(row.accepted_at), cancelledAt: iso(row.cancelled_at),
    completedAt: iso(row.completed_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

export async function listSellerOrders({ tenantId, merchantId, filters,
  connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId); const merchant = uuidToBuffer(merchantId);
  const where = ["so.tenant_id = ?", "so.merchant_id = ?"];
  const parameters = [tenant, merchant];
  if (filters.search) {
    const search = `%${escapeSearch(filters.search)}%`;
    where.push(`(so.seller_order_number LIKE ? ESCAPE '\\\\' OR co.order_number LIKE ? ESCAPE '\\\\'
      OR CONCAT_WS(' ', c.first_name, c.last_name) LIKE ? ESCAPE '\\\\'
      OR c.email LIKE ? ESCAPE '\\\\' OR c.phone LIKE ? ESCAPE '\\\\'
      OR EXISTS (SELECT 1 FROM order_items search_item WHERE search_item.seller_order_id = so.id
        AND (search_item.product_name LIKE ? ESCAPE '\\\\' OR search_item.sku LIKE ? ESCAPE '\\\\')))`);
    parameters.push(search, search, search, search, search, search, search);
  }
  if (filters.status !== "ALL") { where.push("so.status = ?"); parameters.push(filters.status); }
  if (filters.fulfillmentStatus !== "ALL") {
    where.push("so.fulfillment_status = ?"); parameters.push(filters.fulfillmentStatus);
  }
  const clause = where.join(" AND "); const offset = (filters.page - 1) * filters.pageSize;
  const select = `SELECT so.*, co.order_number, co.payment_status, co.currency, co.placed_at,
      s.name AS store_name,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
        JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.name'))) AS customer_name,
      COALESCE(c.email, JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.email'))) AS customer_email,
      COALESCE(c.phone, JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.phone'))) AS customer_phone,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.seller_order_id = so.id) AS item_count,
      (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.seller_order_id = so.id) AS total_quantity,
      (SELECT oi.product_name FROM order_items oi WHERE oi.seller_order_id = so.id
        ORDER BY oi.created_at, oi.id LIMIT 1) AS primary_item_name
    FROM seller_orders so JOIN customer_orders co ON co.id = so.customer_order_id
    JOIN stores s ON s.id = co.store_id LEFT JOIN customers c ON c.id = co.customer_id`;
  const [rowsResult, countResult, summaryResult] = await Promise.all([
    connection.execute(`${select} WHERE ${clause}
      ORDER BY COALESCE(co.placed_at, so.created_at) DESC, so.created_at DESC LIMIT ? OFFSET ?`,
    [...parameters, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total FROM seller_orders so
      JOIN customer_orders co ON co.id = so.customer_order_id LEFT JOIN customers c ON c.id = co.customer_id
      WHERE ${clause}`, parameters),
    connection.execute(`SELECT COUNT(*) AS total,
      SUM(so.status IN ('PENDING', 'PLACED')) AS awaiting_action,
      SUM(so.status = 'CONFIRMED' AND so.fulfillment_status = 'UNFULFILLED') AS ready_to_fulfill,
      SUM(so.fulfillment_status = 'PROCESSING') AS processing,
      SUM(so.status = 'COMPLETED') AS completed,
      COALESCE(SUM(CASE WHEN so.status = 'COMPLETED' AND so.completed_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
        THEN so.merchant_payable_total ELSE 0 END), 0) AS payable_30d
      FROM seller_orders so WHERE so.tenant_id = ? AND so.merchant_id = ?`, [tenant, merchant])
  ]);
  const total = Number(countResult[0][0].total || 0); const summary = summaryResult[0][0];
  return { items: rowsResult[0].map(mapSellerOrder), total, page: filters.page,
    pageSize: filters.pageSize, totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
    summary: { total: Number(summary.total || 0), awaitingAction: Number(summary.awaiting_action || 0),
      readyToFulfill: Number(summary.ready_to_fulfill || 0), processing: Number(summary.processing || 0),
      completed: Number(summary.completed || 0), payable30d: number(summary.payable_30d) || 0 } };
}

export async function getSellerOrder({ tenantId, merchantId, sellerOrderId,
  connection = getPrimaryPool(), forUpdate = false }) {
  const tenant = uuidToBuffer(tenantId); const merchant = uuidToBuffer(merchantId);
  const seller = uuidToBuffer(sellerOrderId);
  const [orderRows] = await connection.execute(`SELECT so.*, co.order_number, co.payment_status,
      co.currency, co.placed_at, co.customer_notes, co.shipping_address_snapshot, co.customer_snapshot,
      s.name AS store_name, m.status AS merchant_status,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
        JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.name'))) AS customer_name,
      COALESCE(c.email, JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.email'))) AS customer_email,
      COALESCE(c.phone, JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.phone'))) AS customer_phone,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.seller_order_id = so.id) AS item_count,
      (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.seller_order_id = so.id) AS total_quantity,
      (SELECT oi.product_name FROM order_items oi WHERE oi.seller_order_id = so.id
        ORDER BY oi.created_at, oi.id LIMIT 1) AS primary_item_name
    FROM seller_orders so JOIN customer_orders co ON co.id = so.customer_order_id
    JOIN stores s ON s.id = co.store_id JOIN merchants m ON m.id = so.merchant_id
    LEFT JOIN customers c ON c.id = co.customer_id
    WHERE so.tenant_id = ? AND so.merchant_id = ? AND so.id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
  [tenant, merchant, seller]);
  if (!orderRows[0]) return null;
  const row = orderRows[0];
  const [itemsResult, fulfillmentResult, allocationResult, serialResult, historyResult] = await Promise.all([
    connection.execute(`SELECT oi.id, oi.product_name, oi.variant_name, oi.sku, oi.quantity,
      oi.estimated_weight, oi.actual_weight, oi.unit_price, oi.list_price, oi.discount_total,
      oi.tax_total, oi.line_total, oi.substitution_preference, oi.product_snapshot, oi.status
      FROM order_items oi WHERE oi.tenant_id = ? AND oi.seller_order_id = ?
      ORDER BY oi.created_at, oi.id`, [tenant, seller]),
    connection.execute(`SELECT f.id, f.fulfillment_number, f.status, f.fulfillment_type,
      f.picking_started_at, f.packed_at, f.dispatched_at, f.completed_at, f.notes,
      w.name AS warehouse_name, sh.provider_code, sh.service_code, sh.tracking_number,
      sh.status AS shipment_status, sh.package_count, sh.package_weight
      FROM fulfillments f JOIN warehouses w ON w.id = f.warehouse_id
      LEFT JOIN shipments sh ON sh.fulfillment_id = f.id
      WHERE f.tenant_id = ? AND f.seller_order_id = ? ORDER BY f.created_at`, [tenant, seller]),
    connection.execute(`SELECT fi.id, fi.fulfillment_id, fi.order_item_id, fi.bundle_component_id,
      fi.requested_quantity, fi.picked_quantity, fi.packed_quantity, fi.actual_weight,
      COALESCE(oibc.product_name, oi.product_name) AS product_name,
      COALESCE(oibc.variant_name, oi.variant_name) AS variant_name,
      COALESCE(oibc.sku, oi.sku) AS sku, oi.product_name AS bundle_product_name,
      il.lot_number, il.expires_at
      FROM fulfillment_items fi JOIN fulfillments f ON f.id = fi.fulfillment_id
      JOIN order_items oi ON oi.id = fi.order_item_id
      LEFT JOIN order_item_bundle_components oibc ON oibc.id = fi.bundle_component_id
      LEFT JOIN inventory_lots il ON il.id = fi.inventory_lot_id
      WHERE f.tenant_id = ? AND f.seller_order_id = ?
      ORDER BY fi.fulfillment_id, oi.created_at, il.expires_at`, [tenant, seller]),
    connection.execute(`SELECT fis.fulfillment_item_id, sn.id, sn.serial_number, sn.status
      FROM fulfillment_item_serials fis JOIN serial_numbers sn ON sn.id = fis.serial_number_id
      JOIN fulfillment_items fi ON fi.id = fis.fulfillment_item_id
      JOIN fulfillments f ON f.id = fi.fulfillment_id
      WHERE f.tenant_id = ? AND f.seller_order_id = ? ORDER BY sn.serial_number`, [tenant, seller]),
    connection.execute(`SELECT osh.id, osh.previous_status, osh.new_status, osh.reason_code,
      osh.notes, osh.changed_at, TRIM(CONCAT_WS(' ', u.first_name, u.last_name)) AS changed_by_name
      FROM order_status_history osh LEFT JOIN users u ON u.id = osh.changed_by
      WHERE osh.tenant_id = ? AND osh.seller_order_id = ? ORDER BY osh.changed_at DESC`, [tenant, seller])
  ]);
  return { order: { ...mapSellerOrder(row), merchantStatus: row.merchant_status,
      customerNotes: row.customer_notes, customer: json(row.customer_snapshot, {}),
      shippingAddress: json(row.shipping_address_snapshot, {}) },
    items: itemsResult[0].map((item) => ({ id: bufferToUuid(item.id), productName: item.product_name,
      variantName: item.variant_name, sku: item.sku, quantity: number(item.quantity),
      estimatedWeight: number(item.estimated_weight), actualWeight: number(item.actual_weight),
      unitPrice: number(item.unit_price), listPrice: number(item.list_price),
      discountTotal: number(item.discount_total), taxTotal: number(item.tax_total),
      lineTotal: number(item.line_total), substitutionPreference: item.substitution_preference,
      product: json(item.product_snapshot, {}), status: item.status })),
    fulfillments: fulfillmentResult[0].map((entry) => ({ id: bufferToUuid(entry.id),
      number: entry.fulfillment_number, status: entry.status, type: entry.fulfillment_type,
      warehouseName: entry.warehouse_name, pickingStartedAt: iso(entry.picking_started_at),
      packedAt: iso(entry.packed_at), dispatchedAt: iso(entry.dispatched_at),
      completedAt: iso(entry.completed_at), notes: entry.notes,
      shipment: entry.tracking_number ? { providerCode: entry.provider_code,
        serviceCode: entry.service_code, trackingNumber: entry.tracking_number,
        status: entry.shipment_status, packageCount: Number(entry.package_count || 0),
        packageWeight: number(entry.package_weight) } : null,
      allocations: allocationResult[0].filter((allocation) => allocation.fulfillment_id.equals(entry.id))
        .map((allocation) => ({ id: bufferToUuid(allocation.id),
          orderItemId: bufferToUuid(allocation.order_item_id), productName: allocation.product_name,
          bundleComponentId: allocation.bundle_component_id ? bufferToUuid(allocation.bundle_component_id) : null,
          bundleProductName: allocation.bundle_component_id ? allocation.bundle_product_name : null,
          variantName: allocation.variant_name, sku: allocation.sku,
          requestedQuantity: number(allocation.requested_quantity),
          pickedQuantity: number(allocation.picked_quantity),
          packedQuantity: number(allocation.packed_quantity), actualWeight: number(allocation.actual_weight),
          lot: allocation.lot_number ? { number: allocation.lot_number,
            expiresAt: allocation.expires_at ? iso(allocation.expires_at).slice(0, 10) : null } : null,
          serials: serialResult[0].filter((serial) => serial.fulfillment_item_id.equals(allocation.id))
            .map((serial) => ({ id: bufferToUuid(serial.id), number: serial.serial_number,
              status: serial.status })) })) })),
    history: historyResult[0].map((entry) => ({ id: bufferToUuid(entry.id),
      previousStatus: entry.previous_status, newStatus: entry.new_status,
      reasonCode: entry.reason_code, notes: entry.notes,
      changedBy: entry.changed_by_name || "System", changedAt: iso(entry.changed_at) })) };
}

export async function updateSellerOrderDecision({ tenantId, merchantId, sellerOrderId,
  orderId, action, connection }) {
  const status = action === "ACCEPT" ? "CONFIRMED" : "CANCELLED";
  await connection.execute(`UPDATE seller_orders SET status = ?, version = version + 1,
      accepted_at = CASE WHEN ? = 'ACCEPT' THEN UTC_TIMESTAMP(6) ELSE accepted_at END,
      cancelled_at = CASE WHEN ? = 'REJECT' THEN UTC_TIMESTAMP(6) ELSE cancelled_at END
    WHERE tenant_id = ? AND merchant_id = ? AND id = ?`, [status, action, action,
    uuidToBuffer(tenantId), uuidToBuffer(merchantId), uuidToBuffer(sellerOrderId)]);
  await connection.execute("UPDATE order_items SET status = ? WHERE tenant_id = ? AND seller_order_id = ?",
    [status, uuidToBuffer(tenantId), uuidToBuffer(sellerOrderId)]);
  const [counts] = await connection.execute(`SELECT
      SUM(status IN ('PENDING', 'PLACED')) AS pending,
      SUM(status <> 'CANCELLED') AS active
    FROM seller_orders WHERE tenant_id = ? AND customer_order_id = ?`,
  [uuidToBuffer(tenantId), uuidToBuffer(orderId)]);
  const pending = Number(counts[0].pending || 0); const active = Number(counts[0].active || 0);
  if (!active) {
    await connection.execute(`UPDATE customer_orders SET status = 'CANCELLED',
      fulfillment_status = 'CANCELLED', cancelled_at = UTC_TIMESTAMP(6), version = version + 1
      WHERE tenant_id = ? AND id = ? AND status IN ('PLACED', 'CONFIRMED')`,
    [uuidToBuffer(tenantId), uuidToBuffer(orderId)]);
    return "CANCELLED";
  }
  if (!pending) {
    await connection.execute(`UPDATE customer_orders SET status = 'CONFIRMED', version = version + 1
      WHERE tenant_id = ? AND id = ? AND status = 'PLACED'`,
    [uuidToBuffer(tenantId), uuidToBuffer(orderId)]);
    return "CONFIRMED";
  }
  return "PLACED";
}
