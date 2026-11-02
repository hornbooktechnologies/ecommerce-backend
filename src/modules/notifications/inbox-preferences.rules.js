const labels = Object.freeze({ ORDERS: "Orders & delivery", RETURNS: "Returns & exchanges", PAYMENTS: "Payments",
  INVENTORY: "Inventory alerts", WARRANTIES: "Warranty updates", IMPORTS: "CSV import results", APPROVALS: "Product & vendor approvals", QUESTIONS:'Product questions & answers' });
const optional = Object.freeze({ ADMIN: Object.freeze(["INVENTORY", "WARRANTIES", "IMPORTS", "APPROVALS", 'QUESTIONS']),
  CUSTOMER: Object.freeze(["RETURNS", "WARRANTIES", 'QUESTIONS']) });
const required = Object.freeze({ ADMIN: Object.freeze(["ORDERS", "RETURNS", "PAYMENTS"]), CUSTOMER: Object.freeze(["ORDERS", "PAYMENTS"]) });
export const optionalCategories = (audience) => optional[audience] || [];
export const isOptionalCategory = (audience, category) => optionalCategories(audience).includes(category);
export function preferencesView(audience, row) {
  const disabled = row?.disabledCategories || [];
  return { revision: row?.revision || 0,
    options: optionalCategories(audience).map((category) => ({ category, label: labels[category], enabled: !disabled.includes(category) })),
    required: (required[audience] || []).map((category) => ({ category, label: labels[category], enabled: true })),
    appliesTo: "FUTURE_IN_APP_DELIVERIES" };
}
