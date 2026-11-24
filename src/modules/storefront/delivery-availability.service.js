import { deliveryAvailability } from "./delivery-availability.dao.js";

// Work with date-only values in the store's Indian calendar, independent of the server timezone.
export function expectedDate(deliveryDays, handlingHours = 0, now = new Date()) {
  const days = Number(deliveryDays) + Math.ceil(Number(handlingHours || 0) / 24);
  return new Date(now.getTime() + 330 * 60000 + days * 86400000).toISOString().slice(0, 10);
}
export function describeDeliveryAvailability(zone, postalCode, handlingHours = 0) {
  if (!zone) return { postalCode, available:false, covered:false, status:'UNSUPPORTED',
    message:'Delivery is not available for this PIN code.', expectedDeliveryDate:null };
  return { postalCode, available:true, covered:true, status:'AVAILABLE', message:'Delivery available',
    expectedDeliveryDate:expectedDate(zone.deliveryDays, handlingHours), deliveryFee:Number(zone.deliveryFee),
    minimumOrderAmount:Number(zone.minimumOrderAmount || 0),
    freeDeliveryThreshold:zone.freeDeliveryThreshold == null ? null : Number(zone.freeDeliveryThreshold) };
}
export async function checkDeliveryAvailability(input) {
  return describeDeliveryAvailability(await deliveryAvailability(input), input.postalCode, input.handlingHours);
}
