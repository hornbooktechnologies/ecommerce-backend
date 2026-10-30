import "dotenv/config";

export const queueName = "customer-order-email";
export const enabled = () => process.env.ORDER_EMAILS_ENABLED === "true";

// Deliberately do not replay historical outbox events when this feature is enabled.
export function orderNotification(event) {
  if (event.type === "order.created") return { kind: "ORDER_RECEIVED", key: event.orderId };
  if (event.type === "order.status.changed" && event.payload.status === "CANCELLED") {
    return { kind: "ORDER_CANCELLED", key: event.orderId };
  }
  if (event.type === "order.fulfillment.status-changed" && event.payload.fulfillmentId) {
    if (event.payload.status === "DISPATCHED") return { kind: "SHIPMENT_DISPATCHED", key: event.payload.fulfillmentId };
    if (event.payload.status === "COMPLETED") return { kind: "SHIPMENT_DELIVERED", key: event.payload.fulfillmentId };
  }
  return null;
}

export const messages = Object.freeze({
  ORDER_RECEIVED: ["Order received", "We received your order. This email is not confirmation of payment; check My Orders for payment and fulfilment details."],
  ORDER_CANCELLED: ["Order cancelled", "Your order was cancelled. Any refund, if applicable, is handled separately; this message does not confirm a refund."],
  SHIPMENT_DISPATCHED: ["Shipment dispatched", "A shipment from your order was dispatched. Other items may ship separately."],
  SHIPMENT_DELIVERED: ["Shipment delivered", "A shipment from your order was marked delivered. Other items may still be in progress."],
  RETURN_REQUESTED: ["Return / exchange request received", "Your request was received and is awaiting review."],
  RETURN_APPROVED: ["Return / exchange request approved", "Your request was approved. Check My Orders or contact the store for the next steps."],
  RETURN_REJECTED: ["Return / exchange request declined", "Your request was declined. Contact the store if you need help."],
  RETURN_RECEIVED: ["Returned items received", "The store recorded receipt of the returned items."],
  RETURN_INSPECTED: ["Returned items inspected", "The store completed inspection of the returned items."],
  RETURN_COMPLETED: ["Return case completed", "The store completed your return case. This message does not confirm that a refund has been paid."],
  EXCHANGE_RESERVED: ["Exchange replacement reserved", "The store reserved replacement stock for your exchange. This is not a dispatch confirmation."],
  EXCHANGE_COMPLETED: ["Exchange processed", "The store processed your replacement. Check My Orders or contact the store for delivery details. Any price difference is handled separately."]
});
