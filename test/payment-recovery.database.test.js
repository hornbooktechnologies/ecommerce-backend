import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { getPrimaryPool, closePrimaryPool } from "../src/database/pool-factory.js";
import { createId, uuidToBuffer as id, bufferToUuid as uuid } from "../src/core/identifiers/uuid.js";
import { createPaymentsService } from "../src/modules/payments/payments.service.js";
import { createCredentialVault } from "../src/modules/payments/razorpay.js";
import { createPaymentWebhooks } from "../src/modules/payments/payment-webhooks.js";
import { createPaymentRecovery } from "../src/modules/payments/payment-recovery.service.js";
import * as recoveryDao from "../src/modules/payments/payment-recovery.dao.js";
import { afterSalesFixture } from "./helpers/customer-after-sales.fixture.js";

test("MariaDB webhook inbox, rotated secrets, replay, late capture, ledger and background-only recovery", {
  skip: process.env.PAYMENT_RECOVERY_DB_TESTS !== "true"
}, async () => {
  const connection = await getPrimaryPool().getConnection();
  const customerId = createId();
  try {
    await connection.beginTransaction();
    const [[store]] = await connection.execute(`SELECT s.id, s.tenant_id FROM stores s JOIN tenants t ON t.id = s.tenant_id
      WHERE t.code = 'HORNBOOK_RETAIL' AND s.code = 'MAIN' AND t.status = 'ACTIVE'`);
    assert.ok(store, "Hornbook MAIN store is required for rollback fixtures");
    const [[user]] = await connection.execute("SELECT id FROM users WHERE deleted_at IS NULL LIMIT 1");
    const scope = { tenantId: uuid(store.tenant_id), storeId: uuid(store.id), customerId, actorUserId: uuid(user.id), connection };
    await connection.execute("INSERT INTO customers (id, tenant_id, first_name, email, status) VALUES (?, ?, 'Recovery test', ?, 'ACTIVE')",
      [id(customerId), store.tenant_id, `${customerId}@example.invalid`]);
    const vault = createCredentialVault(randomBytes(32).toString("hex"));
    const keySecret = "test-api-secret-not-real", webhookSecret = "test-webhook-secret-not-real";
    const entries = new Map(); let creates = 0;
    const payments = createPaymentsService({ vault, transaction: async (_tenant, fn) => fn(connection), gateway: {
      validate: async () => {}, createOrder: async (_account, amount) => ({ id: `order_db${++creates}`, amount, currency: "INR" }),
      payments: async (_account, orderId) => ({ items: entries.get(orderId) || [] }),
      payment: async (_account, paymentId) => [...entries.values()].flat().find((p) => p.id === paymentId)
    } });
    await payments.saveSettings(scope, { codEnabled: true, onlineEnabled: true, keyId: "rzp_test_dbRecovery", keySecret, webhookSecret });
    const config = await payments.getSettings(scope);
    assert.equal(config.webhookConfigured, true);
    assert.doesNotMatch(JSON.stringify(config), /test-api-secret|test-webhook-secret/);
    const accountId = config.webhookUrl.split("/").at(-1);
    const webhook = createPaymentWebhooks({ vault, dao: {
      webhookAccount: (account) => recoveryDao.webhookAccount(account, connection),
      acceptEvent: (event) => recoveryDao.acceptEvent(event, connection)
    } });
    const fixture = await afterSalesFixture(connection, scope, customerId);
    await connection.execute("UPDATE customer_orders SET status = 'PLACED' WHERE id = ?", [id(fixture.orderId)]);
    const order = { id: fixture.orderId, grandTotal: "200" };
    await payments.attach(scope, order, "ONLINE_TEST", { items: [] });
    const receipt = { id: order.id, paymentMethod: "ONLINE_TEST", orderNumber: "RECOVERY-TEST" };
    const started = await payments.start(scope, receipt);
    assert.equal((await payments.start(scope, receipt)).checkout.order_id, started.checkout.order_id);
    assert.equal(creates, 1);
    let payment = { id: "pay_dbRecovery", order_id: started.checkout.order_id, amount: 20000, currency: "INR", status: "authorized", captured: false };
    entries.set(payment.order_id, [payment]);
    function input(eventId, type = "payment.captured", secret = webhookSecret) {
      const body = Buffer.from(JSON.stringify({ event: type, payload: { payment: { entity: { id: payment.id, order_id: payment.order_id } } } }));
      return { accountId, eventId, body, signature: createHmac("sha256", secret).update(body).digest("hex") };
    }
    await webhook.receive(input("event_db1"));
    await webhook.receive(input("event_db1"));
    await assert.rejects(webhook.receive(input("event_db1", "payment.failed")), { code: "WEBHOOK_EVENT_CONFLICT" });
    const [[count]] = await connection.execute("SELECT COUNT(*) AS n FROM payment_webhook_events WHERE account_id = ?", [id(accountId)]);
    assert.equal(Number(count.n), 1);
    // Run only this fixture's work; fail before touching any real pending job.
    const scopedDao = { ...recoveryDao, transaction: (fn) => fn(connection),
      nextEvent: async (db) => { const event = await recoveryDao.nextEvent(db); assert.equal(event?.accountId, accountId); return event; },
      nextAttempt: async (db) => { const attempt = await recoveryDao.nextAttempt(db); assert.equal(attempt?.customerId, customerId); return attempt; } };
    const due = () => connection.execute("UPDATE payment_webhook_events SET next_attempt_at = '1970-01-01' WHERE account_id = ? AND status = 'PENDING'", [id(accountId)]);
    await due();
    assert.equal((await createPaymentRecovery({ dao: scopedDao, payments }).once()).status, "PENDING", "Wait for capture API consistency");
    // Customer cancellation and API-key rotation must not revive the order or lose the old account.
    await connection.execute("UPDATE customer_orders SET status = 'CANCELLED' WHERE id = ?", [id(order.id)]);
    await payments.saveSettings(scope, { codEnabled: true, onlineEnabled: true, webhookSecret: "replacement-webhook-secret" });
    await webhook.receive(input("event_dbOldSecret", "payment.authorized"));
    await webhook.receive(input("event_dbNewSecret", "payment.failed", "replacement-webhook-secret"));
    await payments.saveSettings(scope, { codEnabled: true, onlineEnabled: true, keyId: "rzp_test_rotated", keySecret: "different-api-test-secret" });
    assert.notEqual((await payments.getSettings(scope)).webhookUrl, config.webhookUrl);
    assert.equal((await payments.getSettings(scope)).webhookConfigured, false);
    payment = { ...payment, status: "captured", captured: true }; entries.set(payment.order_id, [payment]);
    await due();
    assert.equal((await createPaymentRecovery({ dao: scopedDao, payments }).once()).paymentStatus, "PAID");
    const callback = { razorpay_order_id: payment.order_id, razorpay_payment_id: payment.id,
      razorpay_signature: createHmac("sha256", keySecret).update(`${payment.order_id}|${payment.id}`).digest("hex") };
    assert.equal((await payments.verify(scope, receipt, callback)).receipt.paymentStatus, "PAID");
    await due(); await createPaymentRecovery({ dao: scopedDao, payments }).once();
    await due(); await createPaymentRecovery({ dao: scopedDao, payments }).once();
    const [[ledger]] = await connection.execute("SELECT COUNT(*) AS n FROM payment_transactions WHERE tenant_id = ? AND provider_transaction_id = ?", [store.tenant_id, payment.id]);
    assert.equal(Number(ledger.n), 1);
    const [[saved]] = await connection.execute("SELECT status, payment_status FROM customer_orders WHERE id = ?", [id(order.id)]);
    assert.equal(saved.status, "CANCELLED"); assert.equal(saved.payment_status, "PAID");
    // A second order recovers with no webhook and no customer callback at all.
    const second = await afterSalesFixture(connection, scope, customerId);
    await connection.execute("UPDATE customer_orders SET status = 'PLACED' WHERE id = ?", [id(second.orderId)]);
    await payments.attach(scope, { id: second.orderId, grandTotal: "200" }, "ONLINE_TEST", { items: [] });
    const next = await payments.start(scope, { id: second.orderId, paymentMethod: "ONLINE_TEST" });
    entries.set(next.checkout.order_id, [{ ...payment, id: "pay_dbRecovery2", order_id: next.checkout.order_id }]);
    await connection.execute("UPDATE storefront_payment_attempts SET next_reconcile_at = '1970-01-01' WHERE order_id = ?", [id(second.orderId)]);
    assert.equal((await createPaymentRecovery({ dao: { ...scopedDao, nextEvent: async () => null }, payments }).once()).paymentStatus, "PAID");
    // Retired webhook secrets expire; current secret continues to authenticate.
    await connection.execute("UPDATE payment_webhook_secrets SET expires_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE account_id = ? AND expires_at IS NOT NULL", [id(accountId)]);
    await assert.rejects(webhook.receive(input("event_expired")), { status: 401 });
    await connection.rollback();
    const [[remaining]] = await connection.execute("SELECT COUNT(*) AS n FROM customer_orders WHERE id = ?", [id(order.id)]);
    assert.equal(Number(remaining.n), 0);
  } finally { await connection.rollback(); connection.release(); await closePrimaryPool(); }
});
