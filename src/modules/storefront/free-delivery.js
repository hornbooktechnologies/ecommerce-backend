// Unit selling price in INR, not MRP, display currency, quantity or cart subtotal.
export function qualifiesForFreeDelivery(row) {
  return Number(row.free_delivery) === 1 || (row.free_delivery_above_inr != null
    && row.sale_price != null && Number(row.sale_price) > Number(row.free_delivery_above_inr));
}
