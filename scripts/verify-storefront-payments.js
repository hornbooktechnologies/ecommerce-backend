import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import { createPaymentsService } from "../src/modules/payments/payments.service.js";
import { createCredentialVault } from "../src/modules/payments/razorpay.js";
import { createOrdersService } from "../src/modules/orders/orders.service.js";
import { getPrimaryPool, closePrimaryPool } from "../src/database/pool-factory.js";
import { createId, uuidToBuffer as id } from "../src/core/identifiers/uuid.js";
import * as accountsDao from "../src/modules/customer-accounts/customer-accounts.dao.js";
import { createCustomerAccountsService } from "../src/modules/customer-accounts/customer-accounts.service.js";
import { createStorefrontCartService } from "../src/modules/storefront-cart/storefront-cart.service.js";
import { createStorefrontCheckoutService } from "../src/modules/storefront-checkout/storefront-checkout.service.js";
import { listProducts } from "../src/modules/storefront/storefront.dao.js";
import { findOffersForOrder, getOrder } from "../src/modules/orders/orders.dao.js";
import { checkoutFixture } from "../test/helpers/storefront-checkout.fixture.js";

const connection = await getPrimaryPool().getConnection();
try {
  const scopedAccounts = Object.fromEntries(Object.entries(accountsDao).map(([name, fn]) => [name, (input) => fn({ ...input, connection })]));
  const transaction = async (_tenant, fn) => fn(connection), mail = [];
  const accounts = createCustomerAccountsService({ dao: scopedAccounts, transaction, mailer: { ready() {}, send: async (value) => mail.push(value) } });
  const cartService = createStorefrontCartService({ accountDao: scopedAccounts, transaction });
  let gatewayOrder, capture, gatewayCalls = 0;
  const secret = "integration-test-secret-not-real";
  const payments = createPaymentsService({ transaction, vault: createCredentialVault(randomBytes(32).toString("hex")), gateway: {
    validate: async () => {}, createOrder: async (_account, amount) => { gatewayCalls++; gatewayOrder = { id: "order_testIntegration", amount, currency: "INR" }; return gatewayOrder; },
    payment: async () => capture, payments: async () => ({ items: capture ? [capture] : [] })
  } });
  const checkout = createStorefrontCheckoutService({ accountDao: scopedAccounts, transaction, payments });
  const scope = await accounts.scope({ tenantCode: "HORNBOOK_RETAIL", storeCode: "MAIN" });
  await connection.beginTransaction();
  const [[actor]] = await connection.execute("SELECT id FROM users WHERE deleted_at IS NULL LIMIT 1");
  const { bufferToUuid } = await import("../src/core/identifiers/uuid.js");
  const ownerScope = { ...scope, actorUserId: bufferToUuid(actor.id) };
  await payments.saveSettings(ownerScope, { codEnabled: true, onlineEnabled: true, keyId: "rzp_test_integration", keySecret: secret });
  assert.equal((await payments.getSettings(ownerScope)).connected, true);
  const products = await listProducts({ scope, filters: { page: 1, pageSize: 100, inStock: true }, connection });
  const taxable = await findOffersForOrder({ ...scope, offerIds: products.items.map((p) => p.offerId), destinationStateCode: "29", connection });
  const product = products.items.find((p) => !p.soldByWeight && taxable.some((t) => t.id === p.offerId && t.taxCategoryId && t.taxRateId && t.registrationGstin));
  assert.ok(product, "A tax-ready stocked Hornbook offer is required for this verification.");
  const email = `checkout-${createId()}@example.invalid`;
  await accounts.register(scope, { email, firstName: "Checkout", lastName: "Rollback" });
  await accounts.verify(scope, { token: mail[0].token, newPassword: "VerifyCheckout-123!" });
  const login = await accounts.login(scope, { email, password: "VerifyCheckout-123!" });
  const token = login.sessionToken;
  const profile = await accounts.address(scope, token, null, { label: "Verification", contactName: "Checkout Recipient", phone: "+919876543210", line1: "123 Test Road", line2: "", landmark: "", city: "Bengaluru", stateCode: "KA", postalCode: "560001", isDefault: true });
  let bag = await cartService.operate(scope, { sessionToken: token }, "sync");
  bag = await cartService.operate(scope, { sessionToken: token }, "update", { offerId: product.offerId, quantity: product.minimumOrderQuantity, revision: bag.revision, cartKey: bag.cartKey });
  const { slotId, couponCode, couponId } = await checkoutFixture(connection, scope);
  const input = { addressId: profile.addresses[0].id, deliverySlotId: slotId, couponCode, paymentMethod: "ONLINE_TEST", notes: "Rollback payment verification", substitutionPreference: "CONTACT_ME", cartKey: bag.cartKey, revision: bag.revision };
  assert.ok((await checkout.options(scope, token, { addressId: input.addressId })).slots.some((slot) => slot.id === slotId));
  await assert.rejects(checkout.quote(scope, token, { ...input, couponCode: "INVALID-CHECKOUT-CODE" }), { status: 422 });
  const quote = await checkout.quote(scope, token, input);
  assert.equal(Number(quote.review.shippingTotal), 29);
  assert.equal(Number(quote.review.promotionDiscount), 10);
  const [[unused]] = await connection.execute("SELECT usage_count FROM coupons WHERE id = ?", [id(couponId)]); assert.equal(unused.usage_count, 0);
  assert.equal((await checkout.read(scope, token, { quoteId: quote.quoteId })).receipt, undefined);
  const result = await checkout.place(scope, token, { quoteId: quote.quoteId }, { requestId: createId(), userAgent: "Rollback verification", ipAddress: "127.0.0.1" });
  const retry = await checkout.place(scope, token, { quoteId: quote.quoteId });
  assert.deepEqual(result, retry);
  const orders = createOrdersService({ transaction });
  await assert.rejects(orders.transitionOrder(scope.tenantId, result.receipt.id, { status: "CONFIRMED" }, {}), { code: "ONLINE_PAYMENT_PENDING" });
  const firstPay = await checkout.pay(scope, token, { quoteId: quote.quoteId });
  const secondPay = await checkout.pay(scope, token, { quoteId: quote.quoteId });
  assert.equal(firstPay.checkout.order_id, secondPay.checkout.order_id); assert.equal(gatewayCalls, 1);
  // Rotation affects future orders, not the account pinned to this attempt.
  await payments.saveSettings(ownerScope, { codEnabled: true, onlineEnabled: true, keyId: "rzp_test_nextAccount", keySecret: "next-test-secret-not-real" });
  capture = { id: "pay_testIntegration", order_id: gatewayOrder.id, amount: gatewayOrder.amount, currency: "INR", status: "captured", captured: true };
  await assert.rejects(checkout.verify(scope, token, { quoteId: quote.quoteId, razorpay_order_id: gatewayOrder.id,
    razorpay_payment_id: capture.id, razorpay_signature: "0".repeat(64) }), { code: "PAYMENT_SIGNATURE_INVALID" });
  const verified = await checkout.verify(scope, token, { quoteId: quote.quoteId, razorpay_order_id: gatewayOrder.id,
    razorpay_payment_id: capture.id, razorpay_signature: createHmac("sha256", secret).update(`${gatewayOrder.id}|${capture.id}`).digest("hex") });
  assert.equal(verified.receipt.paymentStatus, "PAID");
  await checkout.read(scope, token, { quoteId: quote.quoteId });
  const [[ledger]] = await connection.execute("SELECT COUNT(*) AS total FROM payment_transactions WHERE tenant_id = ? AND provider_transaction_id = ?", [id(scope.tenantId), capture.id]);
  assert.equal(Number(ledger.total), 1);
  const admin = await getOrder({ tenantId: scope.tenantId, orderId: result.receipt.id, connection });
  assert.equal(admin.order.source, "STOREFRONT"); assert.equal(admin.order.paymentStatus, "PAID"); assert.equal(admin.order.paymentMethod, "ONLINE_TEST"); assert.ok(admin.sellerOrders.length);
  assert.equal((await cartService.operate(scope, { sessionToken: token }, "sync")).items.length, 0);
  const [[capacity]] = await connection.execute("SELECT reserved_orders FROM delivery_slot_instances WHERE id = ?", [id(slotId)]); assert.equal(capacity.reserved_orders, 1);
  const [[used]] = await connection.execute("SELECT usage_count FROM coupons WHERE id = ?", [id(couponId)]); assert.equal(used.usage_count, 1);
  await assert.rejects(checkout.read(scope, token, { quoteId: createId() }), { status: 404 });
  await connection.rollback();
  assert.equal(await accountsDao.findAccount({ ...scope, email, connection }), null);
  process.stdout.write("PASS: MariaDB tenant settings, encrypted accounts, online checkout, retry reuse, pending-fulfilment guard, signature rejection, capture, credential rotation, one ledger entry and admin visibility. All test data rolled back.\n");
} finally { await connection.rollback(); connection.release(); await closePrimaryPool(); }
