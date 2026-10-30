import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";
import { getPrimaryPool, closePrimaryPool } from "../src/database/pool-factory.js";
import { createId, uuidToBuffer as id, bufferToUuid as uuid } from "../src/core/identifiers/uuid.js";
import * as dao from "../src/modules/notifications/inbox.dao.js";
import { enqueueOrderEvent } from "../src/modules/notifications/order-notifications.dao.js";
import { insertOutbox } from "../src/modules/orders/orders.dao.js";
import { insertReturnRequest } from "../src/modules/returns/returns.dao.js";
import { afterSalesFixture } from "./helpers/customer-after-sales.fixture.js";

// Explicit opt-in. Every fixture and delivery is rolled back; no SMTP or real queue claims.
test("MariaDB inbox: real API ownership, hooks, replay, cutoffs, batching and failure isolation", {
  skip: process.env.INBOX_DB_TESTS !== "true"
}, async () => {
  const pool = getPrimaryPool(), connection = await pool.getConnection();
  const execute = pool.execute, query = pool.query, emailFlag = process.env.ORDER_EMAILS_ENABLED;
  const customerId = createId();
  try {
    process.env.ORDER_EMAILS_ENABLED = "false";
    await connection.beginTransaction();
    // Route all API reads/writes through this rollback-only transaction.
    pool.execute = (...args) => connection.execute(...args);
    pool.query = (...args) => connection.query(...args);
    const [[store]] = await connection.execute(`SELECT s.id, s.tenant_id FROM stores s JOIN tenants t ON t.id = s.tenant_id
      WHERE t.code = 'HORNBOOK_RETAIL' AND s.code = 'MAIN' AND t.status = 'ACTIVE' AND s.status = 'ACTIVE'`);
    assert.ok(store, "Hornbook MAIN fixture store is required");
    const scope = { tenantId: uuid(store.tenant_id), storeId: uuid(store.id) };
    const [[vendor]] = await connection.execute(`SELECT m.id FROM merchants m JOIN vendor_profiles vp ON vp.merchant_id = m.id
      AND vp.tenant_id = m.tenant_id WHERE m.tenant_id = ? AND m.merchant_type = 'VENDOR' AND m.status = 'ACTIVE'
      AND m.deleted_at IS NULL AND vp.onboarding_status = 'APPROVED' LIMIT 1`, [store.tenant_id]);
    assert.ok(vendor, "An approved vendor is required for scope verification");
    async function staff(level, scopeId, permission) {
      const userId = createId(), roleId = createId(), sessionId = createId(), assignmentId = createId();
      await connection.execute("INSERT INTO users (id,email,password_hash,first_name) VALUES (?,?,'not-a-login-hash','Inbox test')", [id(userId), `${userId}@example.invalid`]);
      await connection.execute("INSERT INTO tenant_memberships (id,tenant_id,user_id,status) VALUES (?,?,?,'ACTIVE')", [id(createId()), store.tenant_id, id(userId)]);
      await connection.execute("INSERT INTO roles (id,tenant_id,role_key,name,role_level) VALUES (?,?,?,'Inbox test',?)", [id(roleId), store.tenant_id, `inbox-${roleId}`, level]);
      await connection.execute("INSERT INTO role_permissions (role_id,permission_id) SELECT ?,id FROM permissions WHERE permission_key = ?", [id(roleId), permission]);
      await connection.execute("INSERT INTO user_role_assignments (id,user_id,tenant_id,role_id,scope_type,scope_id) VALUES (?,?,?,?,?,?)",
        [id(assignmentId), id(userId), store.tenant_id, id(roleId), level === "VENDOR" ? "MERCHANT" : "TENANT", id(scopeId)]);
      await connection.execute("INSERT INTO user_sessions (id,user_id,refresh_token_hash,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 1 HOUR))", [id(sessionId), id(userId), randomBytes(32)]);
      return { userId, roleId, sessionId, assignmentId, token: createAccessToken({ userId, sessionId }) };
    }
    const admin = await staff("TENANT", scope.tenantId, "order.read");
    const seller = await staff("VENDOR", uuid(vendor.id), "vendor.order.read");
    await connection.execute("INSERT INTO customers (id,tenant_id,first_name,email,status) VALUES (?,?,'Inbox test',?,'ACTIVE')", [id(customerId), store.tenant_id, `${customerId}@example.invalid`]);
    await connection.execute("INSERT INTO customer_accounts (tenant_id,customer_id,email,password_hash) VALUES (?,?,?,'not-a-login-hash')", [store.tenant_id, id(customerId), `${customerId}@example.invalid`]);
    const customerToken = randomBytes(32).toString("hex");
    await connection.execute("INSERT INTO customer_sessions (token_hash,tenant_id,customer_id,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 1 HOUR))", [createHash("sha256").update(customerToken).digest(), store.tenant_id, id(customerId)]);
    const fixture = await afterSalesFixture(connection, scope, customerId);
    // Only the temporary seller-order fixture is reassigned, never a real order/offer.
    await connection.execute("UPDATE seller_orders SET merchant_id = ? WHERE id = ?", [vendor.id, id(fixture.sellerId)]);
    const event = { id: createId(), tenantId: scope.tenantId, orderId: fixture.orderId, type: "order.created", payload: {} };
    await insertOutbox({ event, connection });
    await enqueueOrderEvent({ event, connection });
    const [events] = await connection.execute("SELECT id,audience FROM inbox_events WHERE order_id = ?", [id(fixture.orderId)]);
    assert.equal(events.length, 3, "One deduplicated event per customer/admin/vendor audience");
    const [[emails]] = await connection.execute("SELECT COUNT(*) AS n FROM background_jobs WHERE deduplication_key = ?", [`ORDER_RECEIVED:${fixture.orderId}`]);
    assert.equal(Number(emails.n), 0, "Inbox delivery is independent of disabled emails");
    for (const entry of events) assert.equal((await dao.processNext({ connection, eventId: uuid(entry.id) })).status, "PROCESSED");
    const customerEventId = uuid(events.find(e => e.audience === "CUSTOMER").id);
    await connection.execute("UPDATE inbox_events SET status = 'QUEUED', recipient_offset = 0 WHERE id = ?", [id(customerEventId)]);
    await dao.processNext({ connection, eventId: customerEventId });
    const [[duplicates]] = await connection.execute("SELECT COUNT(*) AS n FROM inbox_recipients WHERE event_id = ?", [id(customerEventId)]);
    assert.equal(Number(duplicates.n), 1, "Worker replay never duplicates a recipient");

    const app = createApp(), adminPath = "/api/admin/v1/notifications", vendorPath = "/api/vendor/v1/notifications";
    const customerPath = "/api/storefront/v1/HORNBOOK_RETAIL/stores/MAIN/account/notifications";
    const staffRequest = (method, path, person = admin) => request(app)[method](path).set("Authorization", `Bearer ${person.token}`).set("x-tenant-id", scope.tenantId);
    const customerRequest = (method, path) => request(app)[method](path).set("Authorization", `Bearer ${customerToken}`);
    const adminInbox = (await staffRequest("get", adminPath).expect(200)).body.data;
    assert.equal(adminInbox.total, 1); assert.equal(adminInbox.pageSize, 10);
    const adminItem = adminInbox.items[0].id;
    const sellerInbox = (await staffRequest("get", vendorPath, seller).expect(200)).body.data;
    assert.equal(sellerInbox.total, 1); assert.equal(sellerInbox.items[0].target.id, fixture.sellerId);
    const customerInbox = (await customerRequest("get", customerPath).expect(200)).body.data;
    assert.equal(customerInbox.total, 1);
    const customerItem = customerInbox.items[0].id;
    await staffRequest("patch", `${adminPath}/${customerItem}`).send({ read: true }).expect(404);
    await customerRequest("patch", `${customerPath}/${adminItem}`).send({ read: true }).expect(404);
    await staffRequest("get", vendorPath, seller).set("x-merchant-id", createId()).expect(403);
    await staffRequest("get", adminPath).set("x-tenant-id", createId()).expect(403);
    await staffRequest("get", "/api/platform/v1/notifications").expect(403);
    await customerRequest("patch", `${customerPath}/${customerItem}`).send({ read: true }).expect(200);
    assert.equal((await customerRequest("get", `${customerPath}/unread-count`).expect(200)).body.data.unreadCount, 0);
    await customerRequest("patch", `${customerPath}/${customerItem}`).send({ read: false }).expect(200);

    // Permission revocation affects list, counts and mutations immediately.
    await connection.execute("UPDATE user_role_assignments SET revoked_at = UTC_TIMESTAMP(6) WHERE id = ?", [id(admin.assignmentId)]);
    assert.equal((await staffRequest("get", adminPath).expect(200)).body.data.total, 0);
    assert.equal((await staffRequest("get", `${adminPath}/unread-count`).expect(200)).body.data.unreadCount, 0);
    await staffRequest("patch", `${adminPath}/${adminItem}`).send({ read: true }).expect(404);
    await connection.execute("UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(6) WHERE id = ?", [id(admin.sessionId)]);
    await staffRequest("get", adminPath).expect(401);
    await connection.execute("UPDATE tenant_memberships SET status = 'SUSPENDED' WHERE user_id = ?", [id(seller.userId)]);
    await staffRequest("get", vendorPath, seller).expect(403);

    const customerScope = { ...scope, audience: "CUSTOMER", recipientId: customerId };
    for (const changedScope of [{ recipientId: createId() }, { tenantId: createId() }, { storeId: createId() }]) {
      assert.equal(await dao.unreadCount({ scope: { ...customerScope, ...changedScope }, connection }), 0);
      assert.equal(await dao.markRead({ scope: { ...customerScope, ...changedScope }, notificationId: customerItem, read: true, connection }), false);
    }
    const base = { ...scope, audience: "CUSTOMER", kind: "TEST", category: "ORDERS", entityType: "ORDER",
      entityId: fixture.orderId, orderId: fixture.orderId, title: "Test", message: "Test", recipients: [customerId] };
    async function queued(key, recipients = [customerId]) {
      await dao.enqueue({ event: { ...base, key, recipients }, connection });
      const [[row]] = await connection.execute("SELECT id FROM inbox_events WHERE tenant_id = ? AND event_key = ?", [store.tenant_id, key]);
      return uuid(row.id);
    }
    for (let n = 0; n < 11; n++) await dao.processNext({ connection, eventId: await queued(`page-${customerId}-${n}`) });
    const page = await dao.list({ scope: customerScope, page: 1, pageSize: 10, filter: "ALL", connection });
    assert.equal(page.total, 12); assert.equal(page.items.length, 10);
    assert.equal((await dao.list({ scope: customerScope, page: 2, pageSize: 10, filter: "ALL", connection })).items.length, 2);
    const newestId = await queued(`new-${customerId}`);
    await dao.processNext({ connection, eventId: newestId });
    await customerRequest("post", `${customerPath}/read-all`).send({ throughId: page.readThroughId }).expect(200);
    assert.equal(await dao.unreadCount({ scope: customerScope, connection }), 1, "New arrivals stay unread after mark-all");

    const batchId = await queued(`batch-${customerId}`, Array.from({ length: 101 }, () => createId()));
    assert.equal((await dao.processNext({ connection, eventId: batchId })).delivered, 100);
    assert.equal((await dao.processNext({ connection, eventId: batchId })).delivered, 1);
    assert.equal(await dao.processNext({ connection, eventId: batchId }), null);
    const poisonId = await queued(`poison-${customerId}`, [customerId, "invalid-id"]);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await dao.processNext({ connection, eventId: poisonId });
      assert.equal(result.status, attempt < 5 ? "QUEUED" : "FAILED");
      assert.equal(await dao.processNext({ connection, eventId: poisonId }), null, "Backoff/final failure prevents immediate retry");
      const [[failed]] = await connection.execute("SELECT attempt_count,last_error FROM inbox_events WHERE id = ?", [id(poisonId)]);
      assert.equal(failed.attempt_count, attempt); assert.equal(failed.last_error, "INBOX_DELIVERY_FAILED");
      await connection.execute("UPDATE inbox_events SET next_attempt_at = UTC_TIMESTAMP(6) WHERE id = ?", [id(poisonId)]);
    }
    const [[partial]] = await connection.execute("SELECT COUNT(*) AS n FROM inbox_recipients WHERE event_id = ?", [id(poisonId)]);
    assert.equal(Number(partial.n), 0, "A failed batch rolls back partial deliveries");
    const returnId = createId();
    await insertReturnRequest({ record: { id: returnId, tenantId: scope.tenantId, orderId: fixture.orderId,
      sellerOrderId: fixture.sellerId, number: `INBOX-${returnId}`, type: "RETURN", reasonCode: "QUALITY", actorUserId: null }, connection });
    const [[returnEvent]] = await connection.execute("SELECT id,kind FROM inbox_events WHERE entity_id = ? AND audience = 'CUSTOMER'", [id(returnId)]);
    assert.equal(returnEvent.kind, "RETURN_REQUESTED");
    await dao.processNext({ connection, eventId: uuid(returnEvent.id) });
    assert.equal((await customerRequest("get", customerPath).expect(200)).body.data.items[0].target.type, "RETURN");
    await connection.query("SAVEPOINT rejected_business_change");
    await enqueueOrderEvent({ event: { ...event, type: "order.status.changed", payload: { status: "CANCELLED" } }, connection });
    await connection.query("ROLLBACK TO SAVEPOINT rejected_business_change");
    const [[cancelled]] = await connection.execute("SELECT COUNT(*) AS n FROM inbox_events WHERE order_id = ? AND kind = 'ORDER_CANCELLED'", [id(fixture.orderId)]);
    assert.equal(Number(cancelled.n), 0);
    await connection.execute("UPDATE customers SET status = 'INACTIVE' WHERE id = ?", [id(customerId)]);
    await customerRequest("get", customerPath).expect(401);
    await connection.rollback();
    const [[leftovers]] = await connection.execute("SELECT COUNT(*) AS n FROM customers WHERE id = ?", [id(customerId)]);
    assert.equal(Number(leftovers.n), 0);
  } finally {
    pool.execute = execute; pool.query = query;
    await connection.rollback(); connection.release(); await closePrimaryPool();
    if (emailFlag === undefined) delete process.env.ORDER_EMAILS_ENABLED;
    else process.env.ORDER_EMAILS_ENABLED = emailFlag;
  }
});
