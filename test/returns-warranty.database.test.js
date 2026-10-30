import test from "node:test";
import assert from "node:assert/strict";
import { getPrimaryPool, closePrimaryPool } from "../src/database/pool-factory.js";
import { createId, uuidToBuffer as id } from "../src/core/identifiers/uuid.js";
import { voidReturnedWarranties } from "../src/modules/returns/returns.dao.js";

// Session-local tables exercise the real MariaDB query without changing tenant data.
test("return warranty SQL scopes tenant, sale and returned serials, preserves history and rolls back", {
  skip: process.env.RETURN_WARRANTY_DB_TESTS !== "true"
}, async () => {
  const db = await getPrimaryPool().getConnection();
  const tenant = createId(), otherTenant = createId(), returnId = createId();
  const sale = createId(), otherSale = createId(), direct = createId(), bundled = createId();
  const untouched = createId(), directItem = createId(), bundleItem = createId(), pendingItem = createId();
  try {
    await db.query(`CREATE TEMPORARY TABLE warranty_registrations
      (id BINARY(16) PRIMARY KEY, tenant_id BINARY(16), order_item_id BINARY(16),
       serial_number_id BINARY(16), status VARCHAR(20)) ENGINE=InnoDB`);
    await db.query(`CREATE TEMPORARY TABLE return_requests
      (id BINARY(16) PRIMARY KEY, tenant_id BINARY(16)) ENGINE=InnoDB`);
    await db.query(`CREATE TEMPORARY TABLE return_items
      (id BINARY(16) PRIMARY KEY, return_request_id BINARY(16), order_item_id BINARY(16),
       serial_number_id BINARY(16), approved_quantity DECIMAL(19,4)) ENGINE=InnoDB`);
    await db.query(`CREATE TEMPORARY TABLE return_item_bundle_serials
      (return_item_id BINARY(16), serial_number_id BINARY(16)) ENGINE=InnoDB`);
    await db.beginTransaction();
    await db.execute("INSERT INTO return_requests VALUES (?, ?)", [id(returnId), id(tenant)]);
    for (const [item, serial, quantity] of [[directItem, direct, 1], [bundleItem, null, 1], [pendingItem, untouched, 0]]) {
      await db.execute("INSERT INTO return_items VALUES (?, ?, ?, ?, ?)",
        [id(item), id(returnId), id(sale), serial ? id(serial) : null, quantity]);
    }
    await db.execute("INSERT INTO return_item_bundle_serials VALUES (?, ?)", [id(bundleItem), id(bundled)]);
    const cases = [
      [tenant, sale, direct, "ACTIVE", "VOID"],
      [tenant, sale, bundled, "EXPIRED", "VOID"],
      [tenant, sale, direct, "REPLACED", "REPLACED"],
      [tenant, sale, bundled, "VOID", "VOID"],
      [otherTenant, sale, direct, "ACTIVE", "ACTIVE"],
      [tenant, otherSale, direct, "ACTIVE", "ACTIVE"],
      [tenant, sale, untouched, "ACTIVE", "ACTIVE"],
      [tenant, sale, createId(), "ACTIVE", "ACTIVE"]
    ].map(([tenantId, orderItemId, serialId, before, after]) => ({
      id: createId(), tenantId, orderItemId, serialId, before, after
    }));
    for (const row of cases) await db.execute("INSERT INTO warranty_registrations VALUES (?, ?, ?, ?, ?)",
      [id(row.id), id(row.tenantId), id(row.orderItemId), id(row.serialId), row.before]);
    assert.equal(await voidReturnedWarranties({ tenantId: otherTenant, returnId, connection: db }), 0);
    await db.query("SAVEPOINT before_void");
    assert.equal(await voidReturnedWarranties({ tenantId: tenant, returnId, connection: db }), 2);
    assert.equal(await voidReturnedWarranties({ tenantId: tenant, returnId, connection: db }), 0);
    for (const row of cases) {
      const [[saved]] = await db.execute("SELECT status FROM warranty_registrations WHERE id = ?", [id(row.id)]);
      assert.equal(saved.status, row.after);
    }
    await db.query("ROLLBACK TO SAVEPOINT before_void");
    for (const row of cases) {
      const [[saved]] = await db.execute("SELECT status FROM warranty_registrations WHERE id = ?", [id(row.id)]);
      assert.equal(saved.status, row.before);
    }
  } finally {
    await db.rollback();
    db.destroy(); // Discard the connection and its temporary tables.
    await closePrimaryPool();
  }
});
