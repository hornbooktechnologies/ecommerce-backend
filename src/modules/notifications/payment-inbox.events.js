import * as defaultDao from "./inbox.dao.js";

// Called only after the verified capture ledger is written, on the same transaction.
// Read the committed-to-be source rather than trusting client-supplied status/mode.
export function createPaymentInboxEvents({ dao = defaultDao } = {}) {
  return async function enqueueTestPaymentInbox({ tenantId, attemptId, connection }) {
    const capture = await dao.sourceTestCapture({ tenantId, attemptId, connection });
    if (!capture) return;
    const source = await dao.sourceOrder({ tenantId, orderId: capture.orderId, connection });
    if (!source) return;
    const cancelled = capture.orderStatus === "CANCELLED";
    const base = {
      tenantId, storeId: source.storeId, orderId: capture.orderId,
      category: "PAYMENTS", entityType: "ORDER", entityId: capture.orderId,
      kind: cancelled ? "PAYMENT_TEST_CAPTURED_CANCELLED" : "PAYMENT_TEST_CAPTURED"
    };
    const customerMessage = cancelled
      ? "A test payment was verified for this cancelled order. No real money was collected. The order remains cancelled; contact the store for reconciliation. This is not a refund confirmation."
      : "Your test payment was verified. No real money was collected. Check your order for fulfilment updates; payment verification is not a dispatch confirmation.";
    const adminMessage = cancelled
      ? "A test payment was captured for a cancelled order. No real money was collected. Review reconciliation; do not reopen or dispatch the order automatically. No refund is confirmed by this alert."
      : "A test payment was captured and verified. No real money was collected. Review the order and stock before fulfilment; this does not confirm dispatch or vendor settlement.";
    const title = cancelled ? "Test payment on cancelled order — review needed" : "Test payment verified";
    const recipients = await dao.staffRecipients({ tenantId, permission: "order.read", connection });
    for (const group of [
      { audience: "CUSTOMER", recipients: source.customerId ? [source.customerId] : [], permission: null, message: customerMessage },
      { audience: "ADMIN", recipients, permission: "order.read", message: adminMessage }
    ]) {
      if (!group.recipients.length) continue;
      await dao.enqueue({ event: { ...base, ...group, title,
        // Stable across callbacks, recovery, and later order-status changes.
        key: `PAYMENT_TEST_CAPTURE:${capture.paymentId}:${group.audience}` }, connection });
    }
  };
}

export const enqueueTestPaymentInbox = createPaymentInboxEvents();
