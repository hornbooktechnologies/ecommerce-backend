import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { createId } from "../src/core/identifiers/uuid.js";
import { createCredentialVault, createRazorpayGateway, verifySignature } from "../src/modules/payments/razorpay.js";
import { createPaymentsService, minorAmount } from "../src/modules/payments/payments.service.js";
import { paymentSettingsSchema, requirePaymentOwner } from "../src/modules/payments/payments.routes.js";

function setup() {
  const scope = { tenantId: createId(), storeId: createId(), customerId: createId(), connection: {} };
  const vault = createCredentialVault(randomBytes(32).toString("hex")), secret = "test-secret-not-a-real-key";
  const attempt = { id: createId(), orderId: createId(), keyId: "rzp_test_dummy", encrypted: vault.encrypt(secret, scope.tenantId),
    amount: 109900, grandTotal: "1099.0000", orderStatus: "PLACED", paymentStatus: "UNPAID", capturedPaymentId: null, gatewayOrderId: null };
  const receipt = { id: attempt.orderId, paymentMethod: "ONLINE_TEST", orderNumber: "TEST-1" };
  const state = { creates: 0, captures: 0, entries: [], onlineEnabled: true, codEnabled: true };
  const gateway = { validate: async () => {}, createOrder: async (_account, amount) => { state.creates++; return { id: "order_test1", amount, currency: "INR" }; },
    payments: async () => ({ items: state.entries }), payment: async () => state.entries[0] };
  const dao = { settings: async () => ({ ...state, accountId: createId(), keyId: attempt.keyId }), lockStore: async () => true, audit: async () => {},
    saveSettings: async (input) => { state.saved = input; },
    attempt: async (args) => args.tenantId === scope.tenantId && args.customerId === scope.customerId && args.storeId === scope.storeId ? attempt : null,
    saveGatewayOrder: async ({ gatewayOrderId }) => { attempt.gatewayOrderId = gatewayOrderId; },
    captured: async () => { state.captures++; }, attach: async () => {} };
  const service = createPaymentsService({ vault, gateway, dao, transaction: async (_tenant, fn) => fn({}) });
  const capture = (changes = {}) => ({ id: "pay_test1", order_id: "order_test1", amount: attempt.amount, currency: "INR", status: "captured", captured: true, ...changes });
  const input = () => ({ razorpay_order_id: "order_test1", razorpay_payment_id: "pay_test1",
    razorpay_signature: createHmac("sha256", secret).update("order_test1|pay_test1").digest("hex") });
  return { service, scope, state, attempt, receipt, capture, input, secret };
}
test("payment vault is tenant-bound, randomised, authenticated and requires an explicit key", () => {
  const vault = createCredentialVault(randomBytes(32).toString("hex"));
  const encrypted = vault.encrypt("secret-value", "tenant-a");
  assert.notEqual(encrypted, vault.encrypt("secret-value", "tenant-a"));
  assert.equal(vault.decrypt(encrypted, "tenant-a"), "secret-value");
  assert.throws(() => vault.decrypt(encrypted, "tenant-b"), { status: 503 });
  assert.throws(() => createCredentialVault("").encrypt("secret", "tenant"), { status: 503 });
  assert.equal(encrypted.includes("secret-value"), false);
});
test("gateway refuses live keys and never exposes credentials in provider errors", async () => {
  let calls = 0;
  const gateway = createRazorpayGateway({ fetcher: async () => { calls++; throw new Error("SECRET_FROM_PROVIDER"); } });
  await assert.rejects(gateway.validate({ keyId: "rzp_live_key", secret: "s" }), { status: 422 });
  assert.equal(calls, 0);
  await assert.rejects(gateway.validate({ keyId: "rzp_test_key", secret: "s" }), (error) => error.status === 503 && !error.message.includes("SECRET"));
});
test("test-only settings accept strict booleans and only tenant owners", () => {
  assert.ok(paymentSettingsSchema.validate({ codEnabled: true, onlineEnabled: true, keyId: "rzp_live_bad" }).error);
  assert.ok(paymentSettingsSchema.validate({ codEnabled: "true", onlineEnabled: false }).error);
  assert.throws(() => requirePaymentOwner({ context: { tenant: { assignments: [{ scopeType: "TENANT", roleKey: "tenant_staff" }] } } }, {}, () => {}), { status: 403 });
  let allowed = false;
  requirePaymentOwner({ context: { tenant: { assignments: [{ scopeType: "TENANT", roleKey: "tenant_owner" }] } } }, {}, () => { allowed = true; });
  assert.equal(allowed, true);
});
test("online retry reuses the gateway order, verifies capture once, and returns only public checkout data", async () => {
  const s = setup();
  const first = await s.service.start(s.scope, s.receipt);
  assert.equal(first.checkout.amount, 109900); assert.equal(JSON.stringify(first).includes(s.secret), false);
  const retry = await s.service.start(s.scope, s.receipt);
  assert.equal(retry.checkout.order_id, first.checkout.order_id); assert.equal(s.state.creates, 1);
  s.state.entries = [s.capture()];
  const result = await s.service.verify(s.scope, s.receipt, s.input());
  assert.equal(result.receipt.paymentStatus, "PAID"); assert.equal(result.receipt.testMode, true);
  await s.service.verify(s.scope, s.receipt, s.input()); assert.equal(s.state.captures, 1);
  assert.equal((await s.service.start(s.scope, s.receipt)).checkout, undefined);
});
test("forged signature, wrong order, amount, currency, or tenant/customer/store cannot mark paid", async () => {
  const s = setup(); await s.service.start(s.scope, s.receipt); s.state.entries = [s.capture()];
  await assert.rejects(s.service.verify(s.scope, s.receipt, { ...s.input(), razorpay_signature: "0".repeat(64) }), { status: 422 });
  await assert.rejects(s.service.verify(s.scope, s.receipt, { ...s.input(), razorpay_order_id: "order_foreign" }), { status: 422 });
  for (const field of ["tenantId", "customerId", "storeId"]) await assert.rejects(s.service.start({ ...s.scope, [field]: createId() }, s.receipt), { status: 404 });
  for (const change of [{ amount: 100 }, { currency: "USD" }, { order_id: "order_other" }]) {
    s.state.entries = [s.capture(change)]; await assert.rejects(s.service.verify(s.scope, s.receipt, s.input()), { status: 422 });
  }
  s.state.entries = [s.capture()]; s.attempt.grandTotal = "1000";
  await assert.rejects(s.service.verify(s.scope, s.receipt, s.input()), { status: 422 });
  assert.equal(s.state.captures, 0);
});
test("authorised but uncaptured payments remain unpaid; lost callbacks reconcile from the server", async () => {
  const s = setup(); await s.service.start(s.scope, s.receipt);
  s.state.entries = [s.capture({ status: "authorized", captured: false })];
  assert.equal((await s.service.verify(s.scope, s.receipt, s.input())).receipt.paymentStatus, "UNPAID");
  s.state.entries = [s.capture()];
  assert.equal((await s.service.read(s.scope, s.receipt, { refresh: true })).paymentStatus, "PAID");
  assert.equal(s.state.captures, 1);
});
test("cancelled, changed-total and disabled orders cannot start a new charge; late capture does not revive cancellation", async () => {
  const s = setup(); await s.service.start(s.scope, s.receipt);
  s.attempt.grandTotal = "1000"; await assert.rejects(s.service.start(s.scope, s.receipt), { code: "PAYMENT_AMOUNT_CHANGED" });
  s.attempt.grandTotal = "1099"; s.state.onlineEnabled = false;
  await assert.rejects(s.service.start(s.scope, s.receipt), { code: "PAYMENT_METHOD_UNAVAILABLE" });
  s.attempt.orderStatus = "CANCELLED"; await assert.rejects(s.service.start(s.scope, s.receipt), { code: "ORDER_NOT_PAYABLE" });
  s.state.entries = [s.capture()]; const receipt = await s.service.read(s.scope, s.receipt, { refresh: true });
  assert.equal(receipt.status, "CANCELLED"); assert.equal(receipt.canPay, false); assert.equal(receipt.paymentStatus, "PAID");
});
test("COD is configurable, weights are COD-only, secrets are encrypted before persistence, and minor units are exact", async () => {
  const s = setup();
  assert.equal(minorAmount("99.99"), 9999); assert.throws(() => minorAmount("10.001"), { status: 422 });
  assert.throws(() => minorAmount("0"), { status: 422 });
  s.state.codEnabled = false;
  await assert.rejects(s.service.attach(s.scope, {}, "COD", { items: [] }), { code: "PAYMENT_METHOD_UNAVAILABLE" });
  await assert.rejects(s.service.attach(s.scope, {}, "ONLINE_TEST", { items: [{ soldByWeight: true }] }), { status: 422 });
  await s.service.saveSettings(s.scope, { codEnabled: true, onlineEnabled: true, keyId: "rzp_test_replacement", keySecret: s.secret });
  assert.equal(s.state.saved.account.encrypted.includes(s.secret), false);
  assert.equal(JSON.stringify(await s.service.getSettings(s.scope)).includes(s.secret), false);
  assert.equal(verifySignature("wrong", "pay_test1", s.input().razorpay_signature, s.secret), false);
});
