import test from "node:test";
import assert from "node:assert/strict";
import { getPrimaryPool, closePrimaryPool } from "../src/database/pool-factory.js";
import { createId, uuidToBuffer as id, bufferToUuid as uuid } from "../src/core/identifiers/uuid.js";
import * as dao from "../src/modules/notifications/order-notifications.dao.js";
import { insertOutbox } from "../src/modules/orders/orders.dao.js";
import { insertReturnRequest, updateReturnStatus } from "../src/modules/returns/returns.dao.js";
import { afterSalesFixture } from "./helpers/customer-after-sales.fixture.js";
import { createOrderNotificationWorker } from "../src/modules/notifications/order-notifications.service.js";
import { queueName } from "../src/modules/notifications/order-notifications.events.js";

// Opt-in integration test: every write is inside one rolled-back transaction; SMTP is always fake.
test("MariaDB notification hooks, deduplication, retries, ownership, leases and rollback", { skip: process.env.ORDER_EMAIL_DB_TESTS !== "true" }, async () => {
  const pool = getPrimaryPool();
  const connection = await pool.getConnection();
  const previous = process.env.ORDER_EMAILS_ENABLED;
  const customerId = createId();
  process.env.ORDER_EMAILS_ENABLED = "true";
  try {
    await connection.beginTransaction();
    // Never claim pre-existing jobs, even if the user has enabled their worker.
    const [[existing]] = await connection.execute("SELECT COUNT(*) AS n FROM background_jobs WHERE queue_name = ?", [queueName]);
    assert.equal(Number(existing.n), 0, "Use an isolated test DB if real notification jobs already exist.");
    const [[store]] = await connection.execute(`SELECT s.id, s.tenant_id FROM stores s JOIN tenants t ON t.id = s.tenant_id
      WHERE t.code = 'HORNBOOK_RETAIL' AND s.code = 'MAIN' AND t.status = 'ACTIVE' AND s.status = 'ACTIVE'`);
    assert.ok(store, "Hornbook MAIN fixture store is required");
    const scope = { tenantId: uuid(store.tenant_id), storeId: uuid(store.id) };
    await connection.execute(`INSERT INTO customers (id, tenant_id, first_name, email, status) VALUES (?, ?, 'Queue test', ?, 'ACTIVE')`,
      [id(customerId), store.tenant_id, `${customerId}@example.invalid`]);
    await connection.execute(`INSERT INTO customer_accounts (tenant_id, customer_id, email, password_hash) VALUES (?, ?, ?, 'not-a-login-hash')`,
      [store.tenant_id, id(customerId), `${customerId}@example.invalid`]);
    const fixture = await afterSalesFixture(connection, scope, customerId);
    const event = { id: createId(), tenantId: scope.tenantId, orderId: fixture.orderId, type: "order.created", payload: {} };
    await insertOutbox({ event, connection });
    await dao.enqueueOrderEvent({ event, connection });
    const [[count]] = await connection.execute("SELECT COUNT(*) AS n FROM background_jobs WHERE queue_name = ?", [queueName]);
    assert.equal(Number(count.n), 1);
    // The worker's own transactions use savepoints so the outer fixture can always roll back.
    const scopedPool = { getConnection: async () => ({ execute: (...args) => connection.execute(...args),
      beginTransaction: () => connection.query("SAVEPOINT queue_operation"), commit: () => connection.query("RELEASE SAVEPOINT queue_operation"),
      rollback: () => connection.query("ROLLBACK TO SAVEPOINT queue_operation"), release: () => {} }) };
    let job = await dao.claim("test-worker-1", scopedPool);
    assert.equal(job.payload.kind, "ORDER_RECEIVED");
    assert.equal(await dao.claim("test-worker-2", scopedPool), null, "A live lease cannot be claimed twice");
    assert.equal((await dao.recipient(job, connection)).email, `${customerId}@example.invalid`);
    assert.equal(await dao.recipient({ ...job, tenantId: createId() }, connection), null);
    assert.equal(await dao.recipient({ ...job, payload: { ...job.payload, customerId: createId() } }, connection), null);
    assert.equal(await dao.finish({ ...job, token: createId() }, { status: "SUCCEEDED" }, scopedPool), false);
    await dao.finish(job, { status: "QUEUED", error: "ETIMEDOUT", delay: 60 }, scopedPool);
    assert.equal(await dao.claim("test-worker-2", scopedPool), null, "Retry must respect backoff");
    await connection.execute("UPDATE background_jobs SET run_at = UTC_TIMESTAMP(6) WHERE id = ?", [id(job.id)]);
    job = await dao.claim("test-worker-2", scopedPool);
    assert.equal(job.attempt, 2);
    const oldClaim = job;
    await connection.execute("UPDATE background_jobs SET lock_expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE id = ?", [id(job.id)]);
    job = await dao.claim("test-worker-3", scopedPool);
    assert.equal(job.attempt, 3);
    assert.equal(await dao.finish(oldClaim, { status: "SUCCEEDED" }, scopedPool), false);
    await dao.finish(job, { status: "SUCCEEDED" }, scopedPool);
    await dao.enqueueOrderEvent({ event, connection });
    assert.equal(await dao.claim("test-worker-4", scopedPool), null, "Completed jobs stay deduplicated");
    const returnId = createId();
    await insertReturnRequest({ record: { id: returnId, tenantId: scope.tenantId, orderId: fixture.orderId, sellerOrderId: fixture.sellerId,
      number: `MAIL-${returnId}`, type: "RETURN", reasonCode: "QUALITY", actorUserId: null }, connection });
    let sent = 0;
    const worker = createOrderNotificationWorker({ dao: { claim: (name) => dao.claim(name, scopedPool),
      recipient: (entry) => dao.recipient(entry, connection), finish: (entry, result) => dao.finish(entry, result, scopedPool) },
    mailer: { send: async (_job, person) => { assert.equal(person.returnNumber, `MAIL-${returnId}`); sent++; } } });
    assert.equal((await worker.once("fake-mailer")).status, "SUCCEEDED");
    assert.equal(sent, 1);
    await updateReturnStatus({ ...scope, returnId, fromStatus: "REQUESTED", toStatus: "REJECTED", connection });
    assert.equal(await updateReturnStatus({ ...scope, returnId, fromStatus: "REQUESTED", toStatus: "REJECTED", connection }), 0);
    job = await dao.claim("test-worker-5", scopedPool);
    assert.equal(job.payload.kind, "RETURN_REJECTED");
    await connection.execute("UPDATE background_jobs SET attempt_count = max_attempts, lock_expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE id = ?", [id(job.id)]);
    assert.equal(await dao.claim("test-worker-6", scopedPool), null);
    const [[failed]] = await connection.execute("SELECT status FROM background_jobs WHERE id = ?", [id(job.id)]);
    assert.equal(failed.status, "FAILED");
    await connection.execute("UPDATE customers SET status = 'INACTIVE' WHERE id = ?", [id(customerId)]);
    assert.equal(await dao.recipient(job, connection), null);
    await connection.query("SAVEPOINT rejected_event");
    await connection.execute("UPDATE customers SET status = 'ACTIVE' WHERE id = ?", [id(customerId)]);
    await dao.enqueueOrderEvent({ event: { ...event, type: "order.status.changed", payload: { status: "CANCELLED" } }, connection });
    await connection.query("ROLLBACK TO SAVEPOINT rejected_event");
    const [[rolledBack]] = await connection.execute("SELECT COUNT(*) AS n FROM background_jobs WHERE deduplication_key = ?", [`ORDER_CANCELLED:${fixture.orderId}`]);
    assert.equal(Number(rolledBack.n), 0);
    await connection.rollback();
    const [[persisted]] = await connection.execute("SELECT COUNT(*) AS n FROM customers WHERE id = ?", [id(customerId)]);
    assert.equal(Number(persisted.n), 0);
  } finally {
    await connection.rollback(); connection.release(); await closePrimaryPool();
    if (previous === undefined) delete process.env.ORDER_EMAILS_ENABLED;
    else process.env.ORDER_EMAILS_ENABLED = previous;
  }
});
