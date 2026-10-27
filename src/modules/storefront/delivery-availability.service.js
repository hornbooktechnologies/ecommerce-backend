import { deliveryAvailability } from "./delivery-availability.dao.js";

const messages = {
  AVAILABLE: "Delivery slots are available for this PIN code. Choose a slot at checkout.",
  UNSUPPORTED: "This store does not currently deliver to this PIN code. Try another delivery address.",
  NOT_SCHEDULED: "This area is covered, but no delivery slots are scheduled in the next 30 days. Please check again later or contact the store.",
  BOOKING_CLOSED: "This area is covered, but booking is closed for the upcoming slots. Please check again later or try another delivery address.",
  FULL: "This area is covered, but all currently bookable delivery slots are full. Please check again later or try another delivery address."
};

export function describeDeliveryAvailability(row, postalCode) {
  const status = Number(row.available) > 0 ? "AVAILABLE" : !Number(row.zones) ? "UNSUPPORTED"
    : !Number(row.scheduled) ? "NOT_SCHEDULED" : !Number(row.bookable) ? "BOOKING_CLOSED" : "FULL";
  return { postalCode, status, covered: Number(row.zones) > 0, available: status === "AVAILABLE", message: messages[status],
    nextStartsAt: status === "AVAILABLE" && row.next_start ? new Date(row.next_start).toISOString() : null };
}

export async function checkDeliveryAvailability(input) {
  return describeDeliveryAvailability(await deliveryAvailability(input), input.postalCode);
}
