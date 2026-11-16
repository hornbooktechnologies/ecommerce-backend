const alias = (value) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value))
    throw Error("Invalid internal SQL alias");
  return value;
};
export const businessCustomer = (name = "co") =>
  `COALESCE(${alias(name)}.payment_method,'') <> 'ONLINE_TEST'`;
export const businessSeller = (name = "so") =>
  `EXISTS (SELECT 1 FROM customer_orders business_parent WHERE business_parent.tenant_id=${alias(name)}.tenant_id AND business_parent.id=${name}.customer_order_id AND ${businessCustomer("business_parent")})`;
export function businessLedger(name = "ml") {
  const a = alias(name);
  const testSource = (source) =>
    `SELECT 1 FROM seller_orders test_seller JOIN customer_orders test_parent ON test_parent.id=test_seller.customer_order_id AND test_parent.tenant_id=test_seller.tenant_id WHERE test_seller.tenant_id=${a}.tenant_id AND (test_seller.id=${source}.seller_order_id OR (${source}.reference_type='SELLER_ORDER' AND test_seller.id=${source}.reference_id)) AND test_parent.payment_method='ONLINE_TEST'`;
  return `NOT EXISTS (${testSource(a)}) AND NOT EXISTS (SELECT 1 FROM merchant_ledger_entries original_entry WHERE original_entry.tenant_id=${a}.tenant_id AND original_entry.id=${a}.reversal_of_entry_id AND EXISTS (${testSource("original_entry")}))`;
}
