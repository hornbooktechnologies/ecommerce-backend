import { bufferToUuid, uuidToBuffer as id } from "../../core/identifiers/uuid.js";

// A completed fulfilment proves this specific item reached the customer, even
// when other items in a mixed order are still being processed.
export const deliveredItemSql = `EXISTS (SELECT 1 FROM fulfillment_items fi
  JOIN fulfillments f ON f.id = fi.fulfillment_id AND f.tenant_id = i.tenant_id
  WHERE fi.order_item_id = i.id AND f.status = 'COMPLETED')`;

export async function purchase({ tenantId, storeId, customerId, orderId, orderItemId, connection }) {
  const [[row]] = await connection.execute(`SELECT p.id AS product_id,
    (o.status NOT IN ('DRAFT', 'CANCELLED') AND i.status <> 'CANCELLED'
      AND p.deleted_at IS NULL AND ${deliveredItemSql}) AS eligible
    FROM order_items i JOIN customer_orders o ON o.id = i.customer_order_id AND o.tenant_id = i.tenant_id
    JOIN product_variants pv ON pv.id = i.variant_id AND pv.tenant_id = i.tenant_id
    JOIN products p ON p.id = pv.product_id AND p.tenant_id = i.tenant_id
    WHERE o.tenant_id = ? AND o.store_id = ? AND o.customer_id = ? AND o.id = ? AND i.id = ? FOR UPDATE`,
  [id(tenantId), id(storeId), id(customerId), id(orderId), id(orderItemId)]);
  return row ? { productId: bufferToUuid(row.product_id), eligible: Boolean(row.eligible) } : null;
}

export async function existing({ tenantId, customerId, orderItemId, connection }) {
  // Keep the unique slot occupied even if staff soft-delete the review.
  const [[row]] = await connection.execute(`SELECT id, status, deleted_at FROM product_ratings
    WHERE tenant_id = ? AND customer_id = ? AND order_item_id = ? FOR UPDATE`,
  [id(tenantId), id(customerId), id(orderItemId)]);
  return row ? { id: bufferToUuid(row.id), status: row.deleted_at ? "HIDDEN" : row.status } : null;
}

export async function insert({ tenantId, customerId, orderId, orderItemId, productId, reviewId, account, input, connection }) {
  await connection.execute(`INSERT INTO product_ratings
    (id, tenant_id, product_id, customer_id, customer_order_id, order_item_id, rating, title, review_text,
      customer_name_snapshot, customer_email_snapshot, status, source, verified_purchase)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'STOREFRONT', 1)`,
  [id(reviewId), id(tenantId), id(productId), id(customerId), id(orderId), id(orderItemId), input.rating,
    input.title || null, input.review, [account.firstName, account.lastName].filter(Boolean).join(" ").slice(0, 190), account.email]);
}
