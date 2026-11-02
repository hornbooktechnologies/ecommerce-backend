import test from "node:test";
import assert from "node:assert/strict";
import { createNewsletterService } from "../src/modules/newsletter/newsletter.service.js";
import { schemas, validate } from "../src/modules/newsletter/newsletter.validators.js";

const scope = { tenantId: "019a3000-1111-7111-8111-111111111111", storeId: "019a3000-2222-7222-8222-222222222222",
  tenantCode: "HORNBOOK_RETAIL", storeCode: "MAIN", tenantName: "Hornbook Retail" };
const input = { email: "recipient@example.com", consent: true };
function fixture({ mailFails = false, rateLimited = false } = {}) {
  let row = null; const messages = []; const audits = [];
  const dao = {
    async lockStore() { return true; },
    async resolveUnsubscribeStore() { return scope; },
    async findSubscriber({ tenantId, storeId, email, subscriberId }) {
      return row && tenantId === scope.tenantId && (!storeId || storeId === scope.storeId)
        && (email ? row.email === email : row.id === subscriberId) ? { ...row } : null;
    },
    async requestConfirmation(args) { row = { id: args.subscriberId, storeId: scope.storeId, email: args.email,
      status: "PENDING", revision: (row?.revision || 0) + 1, consentVersion: args.consentVersion,
      confirmHash: args.confirmHash.toString("hex"), unsubscribeHash: args.unsubscribeHash.toString("hex"),
      tokenCurrent: true, confirmationDelivery: "PENDING" }; },
    async recordDelivery({ sent, confirmHash }) {
      if (row.confirmHash !== confirmHash.toString("hex") || row.status !== "PENDING") return;
      row.confirmationDelivery = sent ? "SENT" : "FAILED";
      if (!sent) row.confirmHash = null;
    },
    async findToken({ scope: receivedScope, tokenHash, unsubscribe }) {
      return row && receivedScope.tenantId === scope.tenantId && receivedScope.storeId === scope.storeId
        && row[unsubscribe ? "unsubscribeHash" : "confirmHash"] === tokenHash.toString("hex") ? { ...row } : null;
    },
    async activate() { row.status = "ACTIVE"; row.revision += 1; },
    async unsubscribe() { row.status = "UNSUBSCRIBED"; row.confirmHash = null; row.revision += 1; },
    async audit(args) { audits.push(args.action); }
  };
  const service = createNewsletterService({ dao, storeResolver: async () => scope, limiter: async () => !rateLimited,
    transaction: async (_tenantId, operation) => {
      const before = row && { ...row }; const auditLength = audits.length;
      try { return await operation({}); } catch (error) { row = before; audits.length = auditLength; throw error; }
    }, mailer: { ready() {}, async send(message) { messages.push(message); if (mailFails) throw new Error("fixture SMTP failure"); } }
  });
  return { service, row: () => row, messages, audits };
}

test("subscription requires explicit consent and normalizes email", async () => {
  assert.throws(() => validate(schemas.subscribe, { email: input.email, consent: false }), { code: "VALIDATION_FAILED" });
  assert.throws(() => validate(schemas.subscribe, { email: input.email, consent: "true" }), { code: "VALIDATION_FAILED" });
  assert.equal(validate(schemas.subscribe, { email: " RECIPIENT@EXAMPLE.COM ", consent: true }).email, input.email);
  const h = fixture(); await assert.rejects(h.service.subscribe(scope, { email: input.email }), { code: "NEWSLETTER_CONSENT_REQUIRED" });
  assert.equal(h.messages.length, 0); assert.equal(h.row(), null);
});
test("email request remains pending until the recipient confirms; repeat confirmation is safe", async () => {
  const h = fixture(); await h.service.subscribe(scope, input);
  assert.equal(h.row().status, "PENDING"); assert.equal(h.row().confirmationDelivery, "SENT");
  const token = h.messages[0].confirmToken;
  await h.service.confirm(scope, { token }); await h.service.confirm(scope, { token });
  assert.equal(h.row().status, "ACTIVE");
  assert.equal(h.audits.filter((action) => action === "newsletter.subscription_confirmed").length, 1);
  const response = await h.service.subscribe(scope, input);
  assert.equal(h.messages.length, 1); assert.equal(response.message.includes("eligible"), true);
});
test("expired and cross-store confirmation tokens cannot activate a subscription", async () => {
  const h = fixture(); await h.service.subscribe(scope, input); const token = h.messages[0].confirmToken;
  h.row().tokenCurrent = false;
  await assert.rejects(h.service.confirm(scope, { token }), { code: "NEWSLETTER_LINK_INVALID" });
  h.row().tokenCurrent = true;
  await assert.rejects(h.service.confirm({ ...scope, storeId: "another-store" }, { token }), { code: "NEWSLETTER_LINK_INVALID" });
  await assert.rejects(h.service.confirm({ ...scope, tenantId: "another-tenant" }, { token }), { code: "NEWSLETTER_LINK_INVALID" });
  assert.equal(h.row().status, "PENDING");
});
test("unsubscribe is repeat-safe and cancels an outstanding confirmation link", async () => {
  const h = fixture(); await h.service.subscribe(scope, input); const message = h.messages[0];
  await h.service.unsubscribe(scope, { token: message.unsubscribeToken });
  await h.service.unsubscribe(scope, { token: message.unsubscribeToken });
  assert.equal(h.row().status, "UNSUBSCRIBED");
  await assert.rejects(h.service.confirm(scope, { token: message.confirmToken }), { code: "NEWSLETTER_LINK_INVALID" });
  assert.equal(h.audits.filter((action) => action === "newsletter.unsubscribed").length, 1);
});
test("unsubscribed recipients must request and confirm again; resends replace stale links", async () => {
  const h = fixture(); await h.service.subscribe(scope, input); const first = h.messages[0];
  await h.service.unsubscribe(scope, { token: first.unsubscribeToken });
  await h.service.subscribe(scope, input); assert.equal(h.row().status, "PENDING");
  await assert.rejects(h.service.confirm(scope, { token: first.confirmToken }), { code: "NEWSLETTER_LINK_INVALID" });
  await h.service.confirm(scope, { token: h.messages[1].confirmToken }); assert.equal(h.row().status, "ACTIVE");
});
test("SMTP failures never activate recipients and invalidate the failed request's token", async () => {
  const h = fixture({ mailFails: true });
  await assert.rejects(h.service.subscribe(scope, input), { code: "NEWSLETTER_EMAIL_UNAVAILABLE" });
  assert.equal(h.row().status, "PENDING"); assert.equal(h.row().confirmationDelivery, "FAILED");
  await assert.rejects(h.service.confirm(scope, { token: h.messages[0].confirmToken }), { code: "NEWSLETTER_LINK_INVALID" });
});
test("rate limits stop mail and data writes", async () => {
  const h = fixture({ rateLimited: true });
  await assert.rejects(h.service.subscribe(scope, input), { code: "TOO_MANY_ATTEMPTS" });
  assert.equal(h.messages.length, 0); assert.equal(h.row(), null);
});
test("admin unsubscribe rejects a stale revision and cannot cross tenant boundaries", async () => {
  const h = fixture(); await h.service.subscribe(scope, input);
  const subscriberId = h.row().id; const context = { actorUserId: scope.tenantId, requestId: "fixture" };
  await assert.rejects(h.service.adminUnsubscribe(scope.tenantId, subscriberId, { expectedRevision: 1 }, context), { code: "NEWSLETTER_CONFIRMATION_REQUIRED" });
  await assert.rejects(h.service.adminUnsubscribe("other-tenant", subscriberId, { expectedRevision: 1, confirmed: true }, context), { code: "NEWSLETTER_SUBSCRIBER_NOT_FOUND" });
  await assert.rejects(h.service.adminUnsubscribe(scope.tenantId, subscriberId, { expectedRevision: 99, confirmed: true }, context), { code: "NEWSLETTER_REVISION_CONFLICT" });
  await h.service.adminUnsubscribe(scope.tenantId, subscriberId, { expectedRevision: h.row().revision, reason: "Requested by recipient", confirmed: true }, context);
  assert.equal(h.row().status, "UNSUBSCRIBED"); assert.equal(h.audits.includes("newsletter.admin_unsubscribed"), true);
});
