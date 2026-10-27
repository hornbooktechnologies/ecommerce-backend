import { createId, uuidToBuffer as id, bufferToUuid as uuid } from "../../src/core/identifiers/uuid.js";

// Only use inside a transaction that the caller always rolls back.
export async function afterSalesFixture(connection, scope, customerId, status = "COMPLETED") {
  const [[offer]] = await connection.execute(`SELECT so.id, so.merchant_id, pv.id AS variant_id, p.id AS product_id, p.name, pv.name AS variant_name, pv.sku
    FROM seller_offers so JOIN product_variants pv ON pv.id = so.variant_id JOIN products p ON p.id = pv.product_id
    JOIN product_types pt ON pt.id = p.product_type_id WHERE so.tenant_id = ? AND so.store_id = ?
    AND pt.vertical = 'CLOTHING' AND p.deleted_at IS NULL AND pv.deleted_at IS NULL AND so.deleted_at IS NULL LIMIT 1`, [id(scope.tenantId), id(scope.storeId)]);
  if (!offer) throw new Error("A clothing offer is needed for the rollback after-sales fixture.");
  await connection.execute("UPDATE products SET is_returnable = 1, return_window_days = 7 WHERE id = ?", [offer.product_id]);
  const [[warehouse]] = await connection.execute("SELECT id FROM warehouses WHERE tenant_id = ? AND deleted_at IS NULL LIMIT 1", [id(scope.tenantId)]);
  const orderId = createId(), sellerId = createId(), itemId = createId(), fulfillmentId = createId();
  await connection.execute(`INSERT INTO customer_orders (id, tenant_id, store_id, customer_id, order_number, status,
    fulfillment_status, billing_address_snapshot, shipping_address_snapshot, customer_snapshot, payment_method, grand_total)
    VALUES (?, ?, ?, ?, ?, 'PROCESSING', ?, '{}', '{}', '{}', 'COD', 200)`,
  [id(orderId), id(scope.tenantId), id(scope.storeId), id(customerId), `AFTER-${orderId}`, status === "COMPLETED" ? "FULFILLED" : "PROCESSING"]);
  await connection.execute(`INSERT INTO seller_orders (id, tenant_id, customer_order_id, merchant_id, seller_order_number, status)
    VALUES (?, ?, ?, ?, ?, 'PROCESSING')`, [id(sellerId), id(scope.tenantId), id(orderId), offer.merchant_id, `AFTER-${sellerId}`]);
  await connection.execute(`INSERT INTO order_items (id, tenant_id, customer_order_id, seller_order_id, offer_id, variant_id,
    product_name, variant_name, sku, quantity, unit_price, list_price, line_total, product_snapshot, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 100, 100, 200, '{}', ?)`, [id(itemId), id(scope.tenantId), id(orderId), id(sellerId),
    offer.id, offer.variant_id, offer.name, offer.variant_name, offer.sku, status === "COMPLETED" ? "FULFILLED" : "PACKED"]);
  await connection.execute(`INSERT INTO fulfillments (id, tenant_id, seller_order_id, warehouse_id, fulfillment_number, status, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [id(fulfillmentId), id(scope.tenantId), id(sellerId), warehouse.id, `AFTER-${fulfillmentId}`, status, status === "COMPLETED" ? new Date() : null]);
  await connection.execute(`INSERT INTO fulfillment_items (id, fulfillment_id, order_item_id, requested_quantity, picked_quantity, packed_quantity)
    VALUES (?, ?, ?, 2, 2, 2)`, [id(createId()), id(fulfillmentId), id(itemId)]);
  return { orderId, sellerId, itemId, fulfillmentId, productId: uuid(offer.product_id), offerId: uuid(offer.id), warehouseId: uuid(warehouse.id), name: offer.name };
}
