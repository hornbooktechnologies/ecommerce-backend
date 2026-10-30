import * as dao from "./inbox.dao.js";
import { messages, orderNotification } from "./order-notifications.events.js";

// Snapshot membership in the source transaction; recheck access on every inbox read.
async function enqueueGroup(base, audience, recipients, permission, title, message, extra, connection) {
  if (!recipients.length) return;
  await dao.enqueue({ event: { ...base, audience, permission, title, message: message.replace("This email", "This notification"), recipients, ...extra,
    key: `${base.kind}:${base.deduplicationKey}:${audience}:${extra?.merchantId || "ALL"}` }, connection });
}
export async function enqueueOrderInbox({ event, connection }) {
  const notification = orderNotification(event);
  if (!notification) return;
  const source = await dao.sourceOrder({ tenantId: event.tenantId, orderId: event.orderId, connection });
  if (!source) return;
  const base = { tenantId: event.tenantId, storeId: source.storeId, kind: notification.kind,
    category: "ORDERS", entityType: "ORDER", entityId: event.orderId, orderId: event.orderId,
    deduplicationKey: notification.key };
  await enqueueGroup(base, "CUSTOMER", source.customerId ? [source.customerId] : [], null,
    ...messages[notification.kind], {}, connection);
  if (notification.kind === "ORDER_RECEIVED") {
    const recipients = await dao.staffRecipients({ tenantId: event.tenantId, permission: "order.read", connection });
    await enqueueGroup(base, "ADMIN", recipients, "order.read", "New order received",
      "Review the order, payment status and stock before fulfilment. Order receipt is not proof of payment.", {}, connection);
    for (const vendor of await dao.orderVendors({ tenantId: event.tenantId, orderId: event.orderId, connection })) {
      const recipients = await dao.staffRecipients({ tenantId: event.tenantId, merchantId: vendor.merchantId, permission: "vendor.order.read", connection });
      await enqueueGroup(base, "VENDOR", recipients, "vendor.order.read", "New seller order assigned",
        "A seller order is ready for review in your workspace. Check payment and fulfilment details before dispatch.",
        { merchantId: vendor.merchantId, entityType: "SELLER_ORDER", entityId: vendor.sellerOrderId }, connection);
    }
  }
}
export async function enqueueReturnInbox({ tenantId, returnId, kind, key = returnId, connection }) {
  if (!Object.hasOwn(messages, kind) || !/^(RETURN_|EXCHANGE_)/.test(kind)) return;
  const orderId = await dao.sourceReturn({ tenantId, returnId, connection });
  if (!orderId) return;
  const source = await dao.sourceOrder({ tenantId, orderId, connection });
  if (!source) return;
  const base = { tenantId, storeId: source.storeId, kind, category: "RETURNS",
    entityType: "RETURN", entityId: returnId, orderId, deduplicationKey: key };
  await enqueueGroup(base, "CUSTOMER", source.customerId ? [source.customerId] : [], null,
    ...messages[kind], {}, connection);
  if (kind === "RETURN_REQUESTED") {
    const recipients = await dao.staffRecipients({ tenantId, permission: "return.read", connection });
    await enqueueGroup(base, "ADMIN", recipients, "return.read", "Return or exchange needs review",
      "Check eligibility and replacement stock before approving this request.", {}, connection);
  }
}
