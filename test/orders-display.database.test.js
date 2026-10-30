import test from "node:test";
import assert from "node:assert/strict";
import { getPrimaryPool, closePrimaryPool } from "../src/database/pool-factory.js";
import { createId, uuidToBuffer as id, bufferToUuid as uuid } from "../src/core/identifiers/uuid.js";
import { getOrder, listOrders } from "../src/modules/orders/orders.dao.js";

test("order list and detail normalize missing phones and preserve delivery totals", {
  skip: process.env.ORDER_DISPLAY_DB_TESTS !== "true"
}, async () => {
  const connection = await getPrimaryPool().getConnection();
  try {
    await connection.beginTransaction();
    const [[store]] = await connection.execute(`SELECT s.id, s.tenant_id FROM stores s
      JOIN tenants t ON t.id = s.tenant_id WHERE t.code = 'HORNBOOK_RETAIL' AND s.code = 'MAIN'`);
    assert.ok(store, "Hornbook MAIN fixture store required");
    const tenantId = uuid(store.tenant_id), customerId = createId(), orderId = createId();
    const orderNumber = `DISPLAY-${orderId}`;
    await connection.execute("INSERT INTO customers (id, tenant_id, first_name, email, status) VALUES (?, ?, 'Display test', ?, 'ACTIVE')",
      [id(customerId), store.tenant_id, `${customerId}@example.invalid`]);
    await connection.execute(`INSERT INTO customer_orders (id, tenant_id, store_id, customer_id, order_number,
      billing_address_snapshot, shipping_address_snapshot, customer_snapshot, subtotal, shipping_total, grand_total)
      VALUES (?, ?, ?, ?, ?, '{}', '{}', '{}', 200, 29, 229)`,
    [id(orderId), store.tenant_id, store.id, id(customerId), orderNumber]);
    const cases = [
      { phone: null, snapshot: { phone: null }, expected: null },
      { phone: null, snapshot: {}, expected: null },
      { phone: null, snapshot: { phone: "" }, expected: null },
      { phone: null, snapshot: { phone: "   " }, expected: null },
      { phone: null, snapshot: { phone: "null" }, expected: null },
      { phone: null, snapshot: { phone: "+919876543210" }, expected: "+919876543210" },
      { phone: "+919876543211", snapshot: { phone: "+919876543210" }, expected: "+919876543211" },
      { phone: " ", snapshot: { phone: "+919876543210" }, expected: "+919876543210" },
      { phone: "null", snapshot: { phone: "+919876543210" }, expected: "+919876543210" }
    ];
    for (const [index, entry] of cases.entries()) {
      await connection.execute("UPDATE customers SET phone = ? WHERE id = ?", [entry.phone, id(customerId)]);
      await connection.execute("UPDATE customer_orders SET customer_snapshot = ? WHERE id = ?", [JSON.stringify(entry.snapshot), id(orderId)]);
      const details = await getOrder({ tenantId, orderId, connection });
      const list = await listOrders({ tenantId, connection, filters: { search: orderNumber, status: "ALL", paymentStatus: "ALL", fulfillmentStatus: "ALL", page: 1, pageSize: 10 } });
      assert.equal(details.order.customerPhone, entry.expected, `detail case ${index}`);
      assert.equal(list.items[0].customerPhone, entry.expected, `list case ${index}`);
      assert.equal(details.order.shippingTotal, 29);
      assert.equal(details.order.grandTotal, 229);
    }
    await connection.execute("UPDATE customer_orders SET shipping_total = 0, grand_total = 200 WHERE id = ?", [id(orderId)]);
    assert.equal((await getOrder({ tenantId, orderId, connection })).order.shippingTotal, 0);
    assert.equal(await getOrder({ tenantId: createId(), orderId, connection }), null);
  } finally {
    await connection.rollback(); connection.release(); await closePrimaryPool();
  }
});
