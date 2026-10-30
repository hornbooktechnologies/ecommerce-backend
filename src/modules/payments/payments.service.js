import Decimal from "decimal.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import { env } from "../../config/env.js";
import * as defaultDao from "./payments.dao.js";
import { createCredentialVault, createRazorpayGateway, paymentError as fail, verifySignature } from "./razorpay.js";

export function minorAmount(value) {
  const amount = new Decimal(value).times(100);
  if (!amount.isInteger() || amount.lt(100) || amount.gt(Number.MAX_SAFE_INTEGER)) fail("PAYMENT_AMOUNT_INVALID", "Online payment requires a positive INR amount of at least one rupee with no more than two decimal places.", 422);
  return amount.toNumber();
}
export function createPaymentsService({ dao = defaultDao, transaction = withTransaction,
  vault = createCredentialVault(), gateway = createRazorpayGateway() } = {}) {
  const account = (scope, attempt) => ({ keyId: attempt.keyId, secret: vault.decrypt(attempt.encrypted, scope.tenantId) });
  async function options(scope) {
    const settings = await dao.settings(scope);
    if (!settings) fail("STORE_NOT_FOUND", "Store not found.", 404);
    return { codEnabled: settings.codEnabled, onlineEnabled: Boolean(settings.onlineEnabled && settings.accountId && vault.ready), mode: "TEST" };
  }
  async function record(scope, attempt, payment) {
    if (!payment || payment.order_id !== attempt.gatewayOrderId || payment.currency !== "INR" || payment.amount !== attempt.amount
      || minorAmount(attempt.grandTotal) !== attempt.amount || !/^pay_[A-Za-z0-9]+$/.test(payment.id || "")) {
      fail("PAYMENT_MISMATCH", "Payment details do not match this order. Contact the store.", 422);
    }
    if (payment.status !== "captured" || payment.captured !== true) return false;
    if (Number(payment.amount_refunded || 0) > 0) fail("PAYMENT_REFUNDED", "This payment has been refunded. Contact the store before retrying.");
    if (attempt.capturedPaymentId) {
      if (attempt.capturedPaymentId !== payment.id) fail("PAYMENT_CAPTURE_CONFLICT", "Another capture is already recorded for this order. Contact the store.");
      return true;
    }
    await dao.captured({ ...scope, attempt, payment });
    attempt.capturedPaymentId = payment.id; attempt.paymentStatus = "PAID";
    return true;
  }
  async function reconcile(scope, attempt) {
    if (!attempt.gatewayOrderId || attempt.capturedPaymentId) return;
    const result = await gateway.payments(account(scope, attempt), attempt.gatewayOrderId);
    const capture = result.items?.find((payment) => payment.status === "captured");
    if (capture) await record(scope, attempt, capture);
  }
  function receiptView(receipt, attempt) {
    return { ...receipt, status: attempt.orderStatus, paymentStatus: attempt.capturedPaymentId ? "PAID" : "UNPAID", testMode: true,
      canPay: !attempt.capturedPaymentId && attempt.orderStatus === "PLACED",
      message: attempt.capturedPaymentId ? attempt.orderStatus === "CANCELLED" ? "Test payment was captured after cancellation. Contact the store for reconciliation; this order remains cancelled." : "Test payment verified. No real money was collected."
        : attempt.orderStatus === "CANCELLED" ? "This order was cancelled. Do not make another payment."
          : "Order saved. Complete the test payment below. No real money will be collected." };
  }
  return {
    options,
    getSettings: (scope) => transaction(scope.tenantId, async (connection) => {
      const settings = await dao.settings({ ...scope, connection });
      if (!settings) fail("STORE_NOT_FOUND", "Store not found.", 404);
      return { codEnabled: settings.codEnabled, onlineEnabled: settings.onlineEnabled, connected: Boolean(settings.accountId),
        keyHint: settings.keyId ? `rzp_test_…${settings.keyId.slice(-4)}` : "", encryptionReady: vault.ready, mode: "TEST",
        webhookConfigured: Boolean(settings.webhookConfigured),
        webhookUrl: settings.accountId ? `${env.apiPublicUrl.replace(/\/$/, "")}/api/webhooks/razorpay/test/${settings.accountId}` : "" };
    }),
    saveSettings: (scope, input) => transaction(scope.tenantId, async (connection) => {
      const args = { ...scope, connection };
      if (!await dao.lockStore(args)) fail("STORE_NOT_FOUND", "Store not found.", 404);
      const current = await dao.settings(args);
      let savedAccount;
      if (input.keyId || input.keySecret) {
        if (!/^rzp_test_[A-Za-z0-9]+$/.test(input.keyId) || !input.keySecret) fail("TEST_KEYS_REQUIRED", "Provide both the Razorpay Test Key ID and secret.", 422);
        const encrypted = vault.encrypt(input.keySecret, scope.tenantId);
        await gateway.validate({ keyId: input.keyId, secret: input.keySecret });
        savedAccount = { id: createId(), keyId: input.keyId, encrypted };
      }
      if (input.onlineEnabled && (!vault.ready || !(savedAccount || current.accountId))) fail("PAYMENT_ACCOUNT_REQUIRED", "Connect a Razorpay test account before enabling online payments.", 422);
      let webhookEncrypted;
      if (input.webhookSecret) {
        if (!(savedAccount || current.accountId)) fail("PAYMENT_ACCOUNT_REQUIRED", "Connect a test account before saving its webhook secret.", 422);
        if (input.webhookSecret === input.keySecret) fail("WEBHOOK_SECRET_DISTINCT", "Use a separate webhook secret, not the API Key Secret.", 422);
        webhookEncrypted = vault.encrypt(input.webhookSecret, `${scope.tenantId}:webhook`);
      }
      await dao.saveSettings({ ...args, codEnabled: input.codEnabled, onlineEnabled: input.onlineEnabled, account: savedAccount, webhookEncrypted });
      await dao.audit(args);
      return { saved: true };
    }),
    async attach(scope, order, method, review) {
      const settings = await dao.settings(scope);
      if (method === "COD" && !settings?.codEnabled) fail("PAYMENT_METHOD_UNAVAILABLE", "Cash on delivery is not available for this store.");
      if (method === "ONLINE_TEST") {
        if (!settings?.onlineEnabled || !settings.accountId || !vault.ready) fail("PAYMENT_METHOD_UNAVAILABLE", "Online test payments are not available for this store.");
        if (review.items.some((item) => item.soldByWeight)) fail("WEIGHT_PAYMENT_UNAVAILABLE", "Choose cash on delivery for variable-weight items. Their final amount is confirmed after packing.", 422);
      } else if (method !== "COD") fail("PAYMENT_METHOD_REQUIRED", "Choose a payment method.", 422);
      await dao.attach({ ...scope, order, method, accountId: settings.accountId, amountMinor: method === "ONLINE_TEST" ? minorAmount(order.grandTotal) : 0 });
    },
    async read(scope, receipt, { refresh = false } = {}) {
      if (receipt.paymentMethod !== "ONLINE_TEST") return receipt;
      const attempt = await dao.attempt({ ...scope, orderId: receipt.id });
      if (!attempt) fail("PAYMENT_NOT_FOUND", "Payment attempt not found.", 404);
      if (refresh) await reconcile(scope, attempt);
      return receiptView(receipt, attempt);
    },
    async start(scope, receipt) {
      if (receipt.paymentMethod !== "ONLINE_TEST") fail("PAYMENT_NOT_ONLINE", "This order does not use online payment.");
      const attempt = await dao.attempt({ ...scope, orderId: receipt.id });
      if (!attempt) fail("PAYMENT_NOT_FOUND", "Payment attempt not found.", 404);
      await reconcile(scope, attempt);
      if (attempt.capturedPaymentId) return { receipt: receiptView(receipt, attempt) };
      if (attempt.orderStatus !== "PLACED") fail("ORDER_NOT_PAYABLE", "This order can no longer accept online payment. Contact the store.");
      if (!(await options(scope)).onlineEnabled) fail("PAYMENT_METHOD_UNAVAILABLE", "The store has temporarily disabled online payments. Contact the store.");
      if (minorAmount(attempt.grandTotal) !== attempt.amount) fail("PAYMENT_AMOUNT_CHANGED", "The order total changed. Contact the store before making payment.");
      if (!attempt.gatewayOrderId) {
        const result = await gateway.createOrder(account(scope, attempt), attempt.amount, attempt.id);
        if (!/^order_[A-Za-z0-9]+$/.test(result.id || "") || result.amount !== attempt.amount || result.currency !== "INR") fail("PAYMENT_PROVIDER_RESPONSE_INVALID", "The payment provider returned invalid order details.", 502);
        await dao.saveGatewayOrder({ ...scope, attemptId: attempt.id, gatewayOrderId: result.id });
        attempt.gatewayOrderId = result.id;
      }
      return { receipt: receiptView(receipt, attempt), checkout: { key: attempt.keyId, order_id: attempt.gatewayOrderId,
        amount: attempt.amount, currency: "INR", name: scope.name || "Store checkout", description: `TEST payment · ${receipt.orderNumber}` } };
    },
    async verify(scope, receipt, input) {
      if (receipt.paymentMethod !== "ONLINE_TEST") fail("PAYMENT_NOT_ONLINE", "This order does not use online payment.");
      const attempt = await dao.attempt({ ...scope, orderId: receipt.id });
      if (!attempt?.gatewayOrderId) fail("PAYMENT_NOT_FOUND", "Payment attempt not found.", 404);
      const credentials = account(scope, attempt);
      if (input.razorpay_order_id !== attempt.gatewayOrderId || !verifySignature(attempt.gatewayOrderId, input.razorpay_payment_id, input.razorpay_signature, credentials.secret)) {
        fail("PAYMENT_SIGNATURE_INVALID", "Payment could not be verified. Refresh the payment status before retrying.", 422);
      }
      await record(scope, attempt, await gateway.payment(credentials, input.razorpay_payment_id));
      return { receipt: receiptView(receipt, attempt) };
    }
  };
}
