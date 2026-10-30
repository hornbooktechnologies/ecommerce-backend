import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createId } from "../src/core/identifiers/uuid.js";
import { AppError } from "../src/core/errors/app-error.js";
import { createCredentialVault, verifyWebhookSignature } from "../src/modules/payments/razorpay.js";
import { createPaymentWebhooks } from "../src/modules/payments/payment-webhooks.js";
import { createPaymentRecovery } from "../src/modules/payments/payment-recovery.service.js";

function webhookSetup() {
  const tenantId = createId(), accountId = createId(), secret = "separate-webhook-test-secret";
  const vault = createCredentialVault(randomBytes(32).toString("hex")), received = [];
  const service = createPaymentWebhooks({ vault, dao: {
    webhookAccount: async (id) => id === accountId ? { tenantId, keyId: "rzp_test_fake", secrets: [vault.encrypt(secret, `${tenantId}:webhook`)] } : null,
    acceptEvent: async (event) => received.push(event)
  } });
  const body = Buffer.from(JSON.stringify({ event: "payment.captured", payload: { payment: { entity: {
    id: "pay_unit", order_id: "order_unit", email: "private@example.invalid", card: { number: "DO_NOT_STORE" }
  } } } }, null, 2));
  const input = { accountId, eventId: "event_unit", body, signature: createHmac("sha256", secret).update(body).digest("hex") };
  return { service, input, secret, received };
}

test("webhooks authenticate exact raw bytes and store only identifiers plus hash", async () => {
  const s = webhookSetup();
  assert.deepEqual(await s.service.receive(s.input), { received: true });
  assert.equal(s.received[0].orderId, "order_unit");
  assert.equal(s.received[0].paymentId, "pay_unit");
  assert.doesNotMatch(JSON.stringify(s.received), /private@|DO_NOT_STORE|separate-webhook/);
  assert.equal(verifyWebhookSignature(Buffer.from(JSON.stringify(JSON.parse(s.input.body))), s.input.signature, s.secret), false);
  for (const changes of [{ signature: "0".repeat(64) }, { accountId: createId() }, { body: JSON.parse(s.input.body) }, { body: Buffer.concat([s.input.body, Buffer.from(" ")]) }]) {
    await assert.rejects(s.service.receive({ ...s.input, ...changes }), { code: "WEBHOOK_SIGNATURE_INVALID" });
  }
  await assert.rejects(s.service.receive({ ...s.input, eventId: "" }), { status: 400 });
});

test("webhook route precedes JSON parsing, caps payloads and requires no browser session", async () => {
  const s = webhookSetup(); const app = createApp({ paymentWebhookService: s.service });
  const url = `/api/webhooks/razorpay/test/${s.input.accountId}`;
  await request(app).post(url).set("Content-Type", "application/json").set("x-razorpay-signature", s.input.signature)
    .set("x-razorpay-event-id", s.input.eventId).send(s.input.body.toString()).expect(200);
  await request(app).post(url).set("Content-Type", "application/json").send(s.input.body.toString()).expect(401);
  const large = await request(app).post(url).set("Content-Type", "application/json").send(JSON.stringify({ content: "x".repeat(132000) })).expect(413);
  assert.equal(large.body.error.code, "WEBHOOK_TOO_LARGE");
  const invalid = Buffer.from("{");
  await request(app).post(url).set("Content-Type", "application/json")
    .set("x-razorpay-signature", createHmac("sha256", s.secret).update(invalid).digest("hex")).send("{").expect(400);
});

test("unknown signed webhook types are ignored; storage failures are not acknowledged", async () => {
  const s = webhookSetup();
  const body = Buffer.from(JSON.stringify({ event: "refund.processed" }));
  assert.equal((await s.service.receive({ ...s.input, body, signature: createHmac("sha256", s.secret).update(body).digest("hex") })).ignored, true);
  const app = createApp({ paymentWebhookService: { receive: async () => { throw new Error("Database unavailable"); } } });
  await request(app).post(`/api/webhooks/razorpay/test/${s.input.accountId}`).send({}).expect(500);
});

function recoverySetup({ paid = true, error = null, missing = false, age = 0, count = 0, type = "payment.captured" } = {}) {
  const scope = { tenantId: createId(), storeId: createId(), customerId: createId(), orderId: createId(), attemptId: createId(), age, failures: 0 };
  const event = { id: createId(), tenantId: scope.tenantId, accountId: createId(), count, age, type };
  const calls = { queries: [], events: [], attempts: [], reads: [] };
  const connection = { query: async (sql) => calls.queries.push(sql) };
  const worker = createPaymentRecovery({ dao: {
    transaction: async (fn) => fn(connection), nextEvent: async () => event, nextAttempt: async () => null,
    eventAttempt: async () => missing ? null : scope,
    attemptResult: async (...args) => calls.attempts.push(args), eventResult: async (...args) => calls.events.push(args)
  }, payments: { read: async (...args) => { calls.reads.push(args); if (error) throw error; return { paymentStatus: paid ? "PAID" : "UNPAID" }; } } });
  return { worker, scope, calls };
}

test("recovery derives customer/store scope from persisted attempt, not webhook content", async () => {
  const s = recoverySetup(); assert.equal((await s.worker.once()).paymentStatus, "PAID");
  assert.equal(s.calls.reads[0][0].tenantId, s.scope.tenantId);
  assert.equal(s.calls.reads[0][0].customerId, s.scope.customerId);
  assert.deepEqual(s.calls.reads[0][2], { refresh: true });
  assert.equal(s.calls.events[0][1].status, "PROCESSED");
});

test("unknown orders retry matching and eventually ignore; capture API lag remains pending", async () => {
  assert.equal((await recoverySetup({ missing: true }).worker.once()).status, "PENDING");
  assert.equal((await recoverySetup({ missing: true, age: 86400 }).worker.once()).status, "IGNORED");
  assert.equal((await recoverySetup({ paid: false }).worker.once()).status, "PENDING");
  assert.equal((await recoverySetup({ paid: false, count: 19 }).worker.once()).status, "REVIEW");
  assert.equal((await recoverySetup({ paid: false, type: "payment.failed" }).worker.once()).status, "PROCESSED");
});

test("provider outages back off, mismatches require review, SQL failures never commit partial ledgers", async () => {
  const error = new AppError({ code: "PAYMENT_PROVIDER_UNAVAILABLE", message: "Provider unavailable", status: 503 });
  const s = recoverySetup({ error }); assert.equal((await s.worker.once()).status, "PENDING");
  assert.ok(s.calls.queries.includes("ROLLBACK TO SAVEPOINT payment_recovery"));
  assert.equal(s.calls.attempts[0][1].delay, 60);
  assert.equal((await recoverySetup({ error, count: 19 }).worker.once()).status, "REVIEW");
  const mismatch = new AppError({ code: "PAYMENT_MISMATCH", message: "Mismatch", status: 422 });
  assert.equal((await recoverySetup({ error: mismatch }).worker.once()).status, "REVIEW");
  const sql = recoverySetup({ error: new Error("SQL failed") });
  await assert.rejects(sql.worker.once(), /SQL failed/);
  assert.equal(sql.calls.events.length, 0); assert.equal(sql.calls.attempts.length, 0);
});
