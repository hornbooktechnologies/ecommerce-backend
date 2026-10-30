import test from "node:test";
import assert from "node:assert/strict";
import { createId } from "../src/core/identifiers/uuid.js";
import { orderNotification, messages } from "../src/modules/notifications/order-notifications.events.js";
import { createOrderNotificationWorker } from "../src/modules/notifications/order-notifications.service.js";
import { notificationMessage, createOrderMailer } from "../src/modules/notifications/order-notifications.mail.js";
import { enqueueOrderEvent, enqueueReturnEvent } from "../src/modules/notifications/order-notifications.dao.js";

const job = { id: createId(), tenantId: createId(), token: createId(), attempt: 1, maxAttempts: 5,
  payload: { kind: "ORDER_RECEIVED", orderId: createId(), customerId: createId(), returnId: null } };
const recipient = { email: "verified@example.invalid", storeName: "Hornbook\nRetail", tenantName: "Hornbook",
  tenantCode: "HORNBOOK_RETAIL", storeCode: "MAIN", orderNumber: "ORD-123", returnNumber: null };
const settings = { origin: "https://shop.example.invalid", from: "mail@example.invalid" };

function worker({ nextJob = job, person = recipient, failure, ack = true } = {}) {
  const calls = { sent: [], finished: [] };
  const service = createOrderNotificationWorker({ dao: {
    claim: async () => nextJob, recipient: async (claimed) => { assert.equal(claimed, nextJob); return person; },
    finish: async (claimed, result) => { calls.finished.push({ claimed, ...result }); return ack; }
  }, mailer: { send: async (...args) => { calls.sent.push(args); if (failure) throw failure; } } });
  return { service, calls };
}

test("event mapping selects only customer-facing order events with per-shipment identities", () => {
  const event = { orderId: job.payload.orderId, payload: { fulfillmentId: createId(), status: "DISPATCHED" } };
  assert.deepEqual(orderNotification({ ...event, type: "order.created" }), { kind: "ORDER_RECEIVED", key: event.orderId });
  assert.deepEqual(orderNotification({ ...event, type: "order.fulfillment.status-changed" }), { kind: "SHIPMENT_DISPATCHED", key: event.payload.fulfillmentId });
  assert.equal(orderNotification({ ...event, type: "order.status.changed" }), null);
  assert.equal(orderNotification({ ...event, type: "order.fulfillment.created" }), null);
  assert.equal(orderNotification({ ...event, type: "order.status.changed", payload: { status: "CANCELLED" } }).kind, "ORDER_CANCELLED");
});

test("disabled feature performs no enqueue queries", async () => {
  const previous = process.env.ORDER_EMAILS_ENABLED;
  process.env.ORDER_EMAILS_ENABLED = "false";
  try {
    const connection = { execute: () => { throw new Error("Must not query"); } };
    await enqueueOrderEvent({ event: {}, connection });
    await enqueueReturnEvent({ connection });
  } finally {
    if (previous === undefined) delete process.env.ORDER_EMAILS_ENABLED;
    else process.env.ORDER_EMAILS_ENABLED = previous;
  }
});

test("empty queue, ineligible recipient, and successful SMTP acceptance", async () => {
  assert.equal(await worker({ nextJob: null }).service.once("test"), null);
  const skipped = worker({ person: null });
  assert.equal((await skipped.service.once("test")).status, "SKIPPED");
  assert.equal(skipped.calls.sent.length, 0);
  const success = worker();
  assert.equal((await success.service.once("test")).status, "SUCCEEDED");
  assert.equal(success.calls.sent.length, 1);
  assert.equal(success.calls.finished.length, 1);
});

test("bounded retries redact SMTP error details, then stop at maximum attempts", async () => {
  const failure = Object.assign(new Error("Secret password and private@example.invalid"), { code: "EAUTH" });
  const retry = worker({ failure });
  assert.equal((await retry.service.once("test")).status, "QUEUED");
  assert.equal(retry.calls.finished[0].delay, 60);
  assert.equal(retry.calls.finished[0].error, "EAUTH");
  assert.doesNotMatch(JSON.stringify(retry.calls.finished), /Secret|private@/);
  const exhausted = worker({ nextJob: { ...job, attempt: 5 }, failure });
  assert.equal((await exhausted.service.once("test")).status, "FAILED");
  const unknown = worker({ failure: new Error("private details") });
  await unknown.service.once("test");
  assert.equal(unknown.calls.finished[0].error, "NOTIFICATION_DELIVERY_FAILED");
});

test("invalid payloads never send mail and stale claims are reported", async () => {
  for (const payload of [null, {}, { ...job.payload, kind: "INTERNAL_NOTES" }, { ...job.payload, orderId: "invalid" },
    { ...job.payload, kind: "RETURN_COMPLETED" }]) {
    const invalid = worker({ nextJob: { ...job, payload } });
    assert.equal((await invalid.service.once("test")).status, "FAILED");
    assert.equal(invalid.calls.sent.length, 0);
  }
  assert.equal((await worker({ ack: false }).service.once("test")).status, "LEASE_LOST");
});

test("notification copy is bounded and does not leak staff data or claim paid/refunded", () => {
  for (const kind of Object.keys(messages)) {
    const message = notificationMessage({ ...job, payload: { ...job.payload, kind, internalNotes: "PRIVATE" } },
      { ...recipient, internalNotes: "PRIVATE", returnNumber: "RET-123" }, settings);
    assert.doesNotMatch(message.subject, /[\r\n]/);
    assert.doesNotMatch(message.text, /PRIVATE/);
    assert.match(message.text, /https:\/\/shop.example.invalid\/account\/orders/);
    assert.equal(message.to.address, recipient.email);
    assert.equal(message.messageId, notificationMessage(job, recipient, settings).messageId);
  }
  assert.match(notificationMessage(job, recipient, settings).text, /not confirmation of payment/);
  assert.match(messages.RETURN_COMPLETED[1], /does not confirm/);
});

test("mailer closes transport on success/rejection and accepts only the intended recipient", async () => {
  for (const accepted of [[recipient.email], ["someone-else@example.invalid"], []]) {
    let closed = 0, sent;
    const mailer = createOrderMailer({ settingsFor: () => settings, createTransport: (config) => {
      assert.equal(config.disableFileAccess, true); assert.equal(config.requireTLS, true);
      return { sendMail: async (message) => { sent = message; return { accepted }; }, close: () => closed++ };
    } });
    if (accepted[0] === recipient.email) await mailer.send(job, recipient);
    else await assert.rejects(mailer.send(job, recipient), { code: "EENVELOPE" });
    assert.equal(closed, 1);
    assert.equal(sent.to.address, recipient.email);
  }
});
