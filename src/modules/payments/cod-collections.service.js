import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { AppError } from "../../core/errors/app-error.js";
import { createId, bufferToUuid as uuid } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaults from "./cod-collections.dao.js";
import * as inbox from "../notifications/inbox.dao.js";
const fail = (code, message, status = 409) => {
  throw new AppError({ code, message, status });
};
export function collectionBlock(order, payments) {
  if (order.payment_method !== "COD")
    return "Only explicit cash-on-delivery orders can use this action.";
  if (
    !["PROCESSING", "COMPLETED"].includes(order.status) ||
    order.fulfillment_status !== "FULFILLED" ||
    !order.delivered
  )
    return "Complete delivery of the entire order before recording COD collection.";
  if (order.currency !== "INR") return "Only INR collection is supported.";
  const amount = new Decimal(order.grand_total);
  if (
    !amount.isFinite() ||
    amount.lte(0) ||
    !amount.eq(amount.toDecimalPlaces(2)) ||
    amount.times(100).gt(Number.MAX_SAFE_INTEGER)
  )
    return "This order needs a supported positive, final INR total with at most two decimal places.";
  if (order.payment_status !== "UNPAID")
    return "This order already has a payment or refund status that requires finance review.";
  if (
    Number(order.refunded_total) > 0 ||
    order.has_returns ||
    order.has_refunds
  )
    return "A return, exchange or refund exists. Full COD collection requires separate finance review.";
  if (
    payments.length > 1 ||
    payments.some(
      (p) =>
        p.payment_method !== "COD" ||
        p.currency !== "INR" ||
        p.status !== "PENDING" ||
        Number(p.captured_amount) > 0 ||
        Number(p.authorized_amount) > 0 ||
        Number(p.refunded_amount) > 0,
    )
  )
    return "Existing payment entries require finance review; partial or mixed payments are not supported.";
  return null;
}
async function notify({ tenantId, order, collectionId, amount, connection }) {
  const source = await inbox.sourceOrder({
    tenantId,
    orderId: order.id,
    connection,
  });
  if (!source) return;
  const staff = await inbox.staffRecipients({
    tenantId,
    permission: "order.payment.collect",
    connection,
  });
  for (const group of [
    {
      audience: "ADMIN",
      recipients: staff,
      permission: "order.payment.collect",
    },
    {
      audience: "CUSTOMER",
      recipients: source.customerId ? [source.customerId] : [],
      permission: null,
    },
  ]) {
    await inbox.enqueue({
      connection,
      event: {
        tenantId,
        storeId: source.storeId,
        orderId: order.id,
        entityType: "ORDER",
        entityId: order.id,
        kind: "COD_COLLECTION_RECORDED",
        category: "PAYMENTS",
        key: `COD_COLLECTION:${collectionId}:${group.audience}`,
        ...group,
        title: "COD collection recorded",
        message: `The store recorded full COD collection of INR ${amount} for ${order.order_number}. This is a manual receipt record, not an online charge or vendor-settlement confirmation.`,
      },
    });
  }
}
export function createCodCollectionsService({
  dao = defaults,
  transaction = withTransaction,
  notifications = notify,
  now = () => new Date(),
} = {}) {
  async function state(tenantId, orderId, connection, lock = false) {
    const order = await dao.order({ tenantId, orderId, connection, lock });
    if (!order) fail("ORDER_NOT_FOUND", "Order was not found.", 404);
    const existing = await dao.collection({ tenantId, orderId, connection }),
      payments = await dao.payments({ tenantId, orderId, connection, lock });
    return { order, existing, payments };
  }
  const view = ({ order, existing, payments }) => ({
    orderId: order.id,
    orderVersion: order.version,
    paymentStatus: order.payment_status,
    amount: new Decimal(order.grand_total).toFixed(2),
    currency: order.currency,
    eligible: !existing && !collectionBlock(order, payments),
    blockedReason: existing ? null : collectionBlock(order, payments),
    collection: dao.receipt(existing),
  });
  return {
    async get(tenantId, orderId) {
      return view(await state(tenantId, orderId));
    },
    async collect(tenantId, orderId, input, context) {
      const normalized = {
        ...input,
        amount: new Decimal(input.amount).toFixed(2),
        collectedAt: new Date(input.collectedAt).toISOString(),
      };
      const requestHash = createHash("sha256")
        .update(JSON.stringify({ orderId, ...normalized }))
        .digest();
      try {
        return await transaction(tenantId, async (connection) => {
          const current = await state(tenantId, orderId, connection, true),
            byRequest = await dao.collection({
              tenantId,
              requestId: input.requestId,
              connection,
            });
          if (byRequest) {
            if (
              uuid(byRequest.order_id) !== orderId ||
              !byRequest.request_hash.equals(requestHash)
            )
              fail(
                "COD_REQUEST_CONFLICT",
                "This request identifier was already used with different details. Check the recorded collection.",
              );
            return { ...view(current), replayed: true };
          }
          if (current.existing)
            fail(
              "COD_ALREADY_RECORDED",
              "COD collection is already recorded. Reload the order to view its receipt.",
            );
          const reason = collectionBlock(current.order, current.payments);
          if (reason) fail("COD_COLLECTION_UNAVAILABLE", reason);
          if (current.order.version !== input.orderVersion)
            fail(
              "COD_ORDER_CHANGED",
              "The order changed. Reload it and confirm the current full amount before recording collection.",
            );
          if (!new Decimal(current.order.grand_total).eq(normalized.amount))
            fail(
              "COD_AMOUNT_CHANGED",
              "The entered amount does not match the final order total. Reload the order.",
            );
          const at = new Date(normalized.collectedAt),
            placed =
              current.order.placed_at && new Date(current.order.placed_at);
          if (at > now() || (placed && at < placed))
            fail(
              "COD_COLLECTION_DATE_INVALID",
              "Collection time must not be in the future or before the order was placed.",
              422,
            );
          const collectionId = createId(),
            paymentId = current.payments.length
              ? uuid(current.payments[0].id)
              : createId();
          await dao.record({
            tenantId,
            order: current.order,
            input: normalized,
            requestHash,
            collectionId,
            paymentId,
            existingPayment: current.payments.length > 0,
            context,
            connection,
          });
          await notifications({
            tenantId,
            order: current.order,
            collectionId,
            amount: normalized.amount,
            connection,
          });
          return {
            ...view(await state(tenantId, orderId, connection)),
            replayed: false,
          };
        });
      } catch (error) {
        if (error.code === "ER_DUP_ENTRY")
          fail(
            "COD_REQUEST_CONFLICT",
            "A collection request was already recorded. Reload the order before trying again.",
          );
        throw error;
      }
    },
  };
}
