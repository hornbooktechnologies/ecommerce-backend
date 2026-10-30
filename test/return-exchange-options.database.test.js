import test from "node:test";
import assert from "node:assert/strict";
import { getPrimaryPool, closePrimaryPool } from "../src/database/pool-factory.js";
import { createId, uuidToBuffer as id, bufferToUuid as uuid } from "../src/core/identifiers/uuid.js";
import * as dao from "../src/modules/returns/returns.dao.js";
import { createReturnsService } from "../src/modules/returns/returns.service.js";
import { afterSalesFixture } from "./helpers/customer-after-sales.fixture.js";

test("full-quantity exchange retains case-scoped replacements after new-return eligibility disappears", {
  skip: process.env.RETURN_EXCHANGE_DB_TESTS !== "true"
}, async () => {
  const connection = await getPrimaryPool().getConnection();
  try {
    await connection.beginTransaction();
    const [[store]] = await connection.execute(`SELECT s.id, s.tenant_id FROM stores s
      JOIN tenants t ON t.id = s.tenant_id WHERE t.code = 'HORNBOOK_RETAIL' AND s.code = 'MAIN'`);
    assert.ok(store, "Hornbook MAIN fixture store required");
    const [[actor]] = await connection.execute("SELECT user_id FROM tenant_memberships WHERE tenant_id = ? AND status = 'ACTIVE' LIMIT 1", [store.tenant_id]);
    const tenantId = uuid(store.tenant_id), customerId = createId();
    await connection.execute("INSERT INTO customers (id, tenant_id, first_name, email, status) VALUES (?, ?, 'Exchange test', ?, 'ACTIVE')",
      [id(customerId), store.tenant_id, `${customerId}@example.invalid`]);
    const fixture = await afterSalesFixture(connection, { tenantId, storeId: uuid(store.id) }, customerId);
    // Pick a real clothing pair; the generated order remains wholly inside this rollback transaction.
    const [[pair]] = await connection.execute(`SELECT a.id AS original_id, a.variant_id, pv.name, pv.sku,
      p.id AS product_id, p.name AS product_name, a.merchant_id, b.id AS replacement_id
      FROM seller_offers a JOIN product_variants pv ON pv.id = a.variant_id
      JOIN products p ON p.id = pv.product_id JOIN product_types pt ON pt.id = p.product_type_id
      JOIN product_variants other ON other.product_id = p.id AND other.id <> pv.id
      JOIN seller_offers b ON b.variant_id = other.id AND b.merchant_id = a.merchant_id AND b.store_id = a.store_id
      JOIN offer_prices price ON price.offer_id = b.id
      WHERE a.tenant_id = ? AND a.store_id = ? AND pt.vertical = 'CLOTHING'
        AND b.status <> 'ARCHIVED' AND b.deleted_at IS NULL AND other.status = 'ACTIVE' AND other.deleted_at IS NULL
        AND (price.starts_at IS NULL OR price.starts_at <= UTC_TIMESTAMP())
        AND (price.ends_at IS NULL OR price.ends_at > UTC_TIMESTAMP()) LIMIT 1`, [store.tenant_id, store.id]);
    assert.ok(pair, "Two clothing variants with a priced replacement are required");
    await connection.execute("UPDATE products SET is_returnable = 1, return_window_days = 7 WHERE id = ?", [pair.product_id]);
    await connection.execute("UPDATE seller_orders SET merchant_id = ? WHERE id = ?", [pair.merchant_id, id(fixture.sellerId)]);
    await connection.execute("UPDATE order_items SET offer_id = ?, variant_id = ?, product_name = ?, variant_name = ?, sku = ? WHERE id = ?",
      [pair.original_id, pair.variant_id, pair.product_name, pair.name, pair.sku, id(fixture.itemId)]);
    const before = await dao.listReturnOptions({ tenantId, connection });
    assert.ok(before.items.find(i => i.id === fixture.itemId)?.replacementOffers.some(o => o.id === uuid(pair.replacement_id)));
    const service = createReturnsService({ transaction: (_, operation) => operation(connection) });
    const created = await service.createReturn(tenantId, { orderItemId: fixture.itemId, returnType: "EXCHANGE",
      quantity: 2, serialIds: [], reasonCode: "SIZE_FIT", customerComments: "Rollback regression" },
    { actorUserId: uuid(actor.user_id), requestId: "exchange-options-test",
      ipAddress: "127.0.0.1", userAgent: "Rollback exchange regression" });
    const returnId = created.request.id;
    assert.ok(!(await dao.listReturnOptions({ tenantId, connection })).items.some(i => i.id === fixture.itemId));
    assert.ok(created.replacementOffers.some(o => o.id === uuid(pair.replacement_id)));
    // Existing cases remain serviceable even after the original return window ends.
    await connection.execute("UPDATE fulfillments SET completed_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY) WHERE id = ?", [id(fixture.fulfillmentId)]);
    const reopened = await dao.getReturn({ tenantId, returnId, connection });
    assert.ok(reopened.replacementOffers.some(o => o.id === uuid(pair.replacement_id)));
    assert.ok(reopened.replacementOffers.every(o => o.orderItemId === fixture.itemId));
    assert.equal(await dao.getReturn({ tenantId: createId(), returnId, connection }), null);
    assert.deepEqual(await dao.listReplacementOffers({ tenantId: createId(), returnId, connection }), []);
  } finally {
    await connection.rollback(); connection.release(); await closePrimaryPool();
  }
});
