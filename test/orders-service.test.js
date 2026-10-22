import assert from "node:assert/strict";
import test from "node:test";
import { createOrdersService } from "../src/modules/orders/orders.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const orderId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const context = { actorUserId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77",
  requestId: "request-1", ipAddress: "127.0.0.1", userAgent: "test" };
const transaction = (_tenantId, operation) => operation({});

test("order lifecycle transition writes history, audit, and outbox together", async () => {
  const calls = [];
  const service = createOrdersService({ transaction, dao: {
    async findOrderForUpdate() { return { id: orderId, status: "PLACED", version: 0 }; },
    async updateOrderStatus(input) { calls.push(["status", input.status]); },
    async insertStatusHistory() { calls.push(["history"]); },
    async insertAudit() { calls.push(["audit"]); },
    async insertOutbox() { calls.push(["outbox"]); },
    async getOrder() { return { order: { id: orderId, status: "CONFIRMED" } }; }
  } });
  const result = await service.transitionOrder(tenantId, orderId, {
    status: "CONFIRMED", reasonCode: "", notes: "Validated"
  }, context);
  assert.equal(result.order.status, "CONFIRMED");
  assert.deepEqual(calls.map(([name]) => name), ["status", "history", "audit", "outbox"]);
});

test("completed orders reject further lifecycle changes", async () => {
  const service = createOrdersService({ transaction, dao: {
    async findOrderForUpdate() { return { id: orderId, status: "COMPLETED", version: 2 }; }
  } });
  await assert.rejects(() => service.transitionOrder(tenantId, orderId, {
    status: "CANCELLED", reasonCode: "OTHER", notes: "Requested after completion"
  }, context), (error) => error.code === "INVALID_ORDER_TRANSITION" && error.status === 409);
});

test("completing an order posts its vendor ledger in the same transaction", async () => {
  let posted = null;
  const service = createOrdersService({ transaction, financeService: {
    async postCompletedOrderLedger(receivedTenant, receivedOrder, receivedContext, connection) {
      posted = { tenantId: receivedTenant, orderId: receivedOrder, context: receivedContext, connection };
    }
  }, dao: {
    async findOrderForUpdate() { return { id: orderId, status: "PROCESSING", version: 1 }; },
    async updateOrderStatus() {}, async insertStatusHistory() {}, async insertAudit() {}, async insertOutbox() {},
    async getOrder() { return { order: { id: orderId, status: "COMPLETED" } }; }
  } });
  const result = await service.transitionOrder(tenantId, orderId, {
    status: "COMPLETED", reasonCode: "FULFILLED", notes: "Delivered"
  }, context);
  assert.equal(result.order.status, "COMPLETED"); assert.equal(posted.tenantId, tenantId);
  assert.equal(posted.orderId, orderId); assert.equal(posted.context.requestId, context.requestId);
});

test("dispatched orders require the returns workflow instead of cancellation", async () => {
  const service = createOrdersService({ transaction, dao: {
    async findOrderForUpdate() { return { id: orderId, status: "PROCESSING", version: 2 }; },
    async hasDispatchedFulfillment() { return true; }
  } });
  await assert.rejects(() => service.transitionOrder(tenantId, orderId, {
    status: "CANCELLED", reasonCode: "CUSTOMER_REQUEST", notes: "Customer requested cancellation"
  }, context), (error) => error.code === "DISPATCHED_ORDER_CANNOT_BE_CANCELLED" && error.status === 409);
});

test("missing order details return a tenant-safe not found response", async () => {
  const service = createOrdersService({ dao: { async getOrder() { return null; } } });
  await assert.rejects(() => service.getOrder(tenantId, orderId),
    (error) => error.code === "ORDER_NOT_FOUND" && error.status === 404);
});

test("bundle availability is calculated from the scarcest required component", async () => {
  const service = createOrdersService({ dao: {
    async listCreationOptions() { return { stores: [], offers: [{ id: "bundle-offer",
      productKind: "BUNDLE", variantId: "bundle-variant", merchantId: "merchant",
      storeId: "store", availableQuantity: 999 }], deliverySlots: [], promotions: [] }; },
    async listRequiredBundleComponents() { return [
      { componentVariantId: "component-a", offerId: "offer-a", productName: "Cable",
        productKind: "STANDARD", quantity: 2, availableQuantity: 5 },
      { componentVariantId: "component-b", offerId: "offer-b", productName: "Adapter",
        productKind: "STANDARD", quantity: 1, availableQuantity: 8 }
    ]; }
  } });
  const options = await service.listCreationOptions(tenantId);
  assert.equal(options.offers[0].availableQuantity, 2);
  assert.deepEqual(options.offers[0].bundleComponents.map((item) => item.quantityPerBundle), [2, 1]);
});

test("manual order creation calculates server-owned totals and seller split", async () => {
  const calls = [];
  let sequence = 0;
  const service = createOrdersService({ transaction, dao: {
    async findStoreContext() { return { id: "store", currency: "INR" }; },
    async findOffersForOrder() { return [{
      id: "offer", merchantId: "merchant", variantId: "variant", merchantName: "Seller",
      productName: "Royal Gala Apples", variantName: "Per kg", sku: "APPLE-KG",
      hsnSacCode: "0808", vertical: "GROCERY", soldByWeight: true,
      taxCategoryId: "tax-category", taxRateId: "tax-rate", registrationGstin: "29ABCDE1234F1Z5",
      registrationStateCode: "29", cgstRate: 2.5, sgstRate: 2.5, igstRate: 5,
      cessRate: 0, cessAmount: 0,
      minimumOrderQuantity: 0.25, maximumOrderQuantity: 5, quantityStep: 0.05,
      estimatedWeight: 1, listPrice: 240, salePrice: 199, availableQuantity: 20,
      imageUrl: "https://example.com/apple.jpg"
    }]; },
    async findCustomer() { return null; },
    async insertCustomer() { calls.push("customer"); },
    async nextDocumentNumber({ type }) { sequence += 1; return `${type}-${sequence}`; },
    async insertOrder({ order }) { calls.push(["order", order.grandTotal]); },
    async insertSellerOrder({ sellerOrder }) { calls.push(["seller", sellerOrder.grandTotal]); },
    async insertOrderItem({ item }) { calls.push(["item", item.quantity, item.lineTotal,
      item.taxableAmount, item.cgstAmount, item.sgstAmount, item.igstAmount]); },
    async insertStatusHistory() { calls.push("history"); },
    async insertAudit() { calls.push("audit"); },
    async insertOutbox() { calls.push("outbox"); },
    async getOrder() { return { order: { id: orderId, grandTotal: 99.5 } }; }
  } });
  const result = await service.createOrder(tenantId, {
    storeId: "store", customer: { firstName: "Ananya", lastName: "", email: "a@example.in", phone: "" },
    shippingAddress: { line1: "42 Market Road", line2: "", landmark: "", city: "Bengaluru",
      stateCode: "KA", stateName: "Karnataka", postalCode: "560001" },
    deliverySlotId: null, items: [{ offerId: "offer", quantity: 0.5,
      substitutionPreference: "ALLOW_SIMILAR" }], customerNotes: "", internalNotes: ""
  }, context);
  assert.equal(result.order.grandTotal, 99.5);
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "order" && call[1] === "99.5000"));
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "item"
    && call[1] === "0.5" && call[2] === "99.5000"));
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "item"
    && call[3] === "94.7620" && call[4] === "2.3690" && call[5] === "2.3690"
    && call[6] === "0.0000"));
  assert.deepEqual(calls.filter((call) => typeof call === "string"),
    ["customer", "history", "audit", "outbox"]);
});

test("manual order creation applies a coupon promotion and records redemption", async () => {
  let insertedOrder; let insertedSeller; let insertedItem; let redemption;
  const service = createOrdersService({ transaction, dao: {
    async findStoreContext() { return { id: "store", currency: "INR" }; },
    async findOffersForOrder() { return [{ id: "offer", merchantId: "merchant", variantId: "variant",
      merchantName: "Seller", productName: "Demo item", variantName: "Standard", sku: "DEMO-1",
      hsnSacCode: "9999", vertical: "GENERAL", soldByWeight: false, minimumOrderQuantity: 1,
      maximumOrderQuantity: 5, quantityStep: 1, estimatedWeight: 1, listPrice: 100, salePrice: 100,
      taxCategoryId: "tax-category", taxRateId: "tax-rate", registrationGstin: "29ABCDE1234F1Z5",
      registrationStateCode: "29", cgstRate: 0, sgstRate: 0, igstRate: 0, cessRate: 0,
      cessAmount: 0, availableQuantity: 10 }]; },
    async findCustomer() { return { id: "customer" }; },
    async findPromotionForOrder() { return { id: "promotion", name: "Save ₹20", type: "FIXED_AMOUNT",
      discountValue: 20, minimumOrderAmount: 0, couponRequired: true, usageLimitTotal: 10,
      usageLimitPerCustomer: 1, redemptionCount: 0, customerRedemptionCount: 0,
      coupon: { id: "coupon", code: "SAVE20", status: "ACTIVE", usageLimit: 10, usageCount: 0 } }; },
    async nextDocumentNumber({ type }) { return `${type}-1`; },
    async insertOrder({ order }) { insertedOrder = order; },
    async insertPromotionRedemption({ redemption: value }) { redemption = value; },
    async insertSellerOrder({ sellerOrder }) { insertedSeller = sellerOrder; },
    async insertOrderItem({ item }) { insertedItem = item; },
    async insertStatusHistory() {}, async insertAudit() {}, async insertOutbox() {},
    async getOrder() { return { order: { id: orderId, grandTotal: 80 } }; }
  } });
  await service.createOrder(tenantId, { storeId: "store",
    customer: { firstName: "Ananya", email: "a@example.in", phone: "" },
    shippingAddress: { line1: "42 Market Road", city: "Bengaluru", stateCode: "KA",
      stateName: "Karnataka", postalCode: "560001" }, deliverySlotId: null,
    promotionId: "promotion", couponCode: "SAVE20",
    items: [{ offerId: "offer", quantity: 1 }], customerNotes: "", internalNotes: "" }, context);
  assert.equal(insertedOrder.discountTotal, "20.0000"); assert.equal(insertedOrder.grandTotal, "80.0000");
  assert.equal(insertedSeller.discountTotal, "20.0000"); assert.equal(insertedItem.lineTotal, "80.0000");
  assert.equal(redemption.discountAmount, "20.0000"); assert.equal(redemption.couponId, "coupon");
});

test("order cancellation reverses promotion usage", async () => {
  let reversed = false;
  const service = createOrdersService({ transaction, dao: {
    async findOrderForUpdate() { return { id: orderId, status: "PLACED", version: 0 }; },
    async hasDispatchedFulfillment() { return false; }, async updateOrderStatus() {},
    async releaseDeliverySlot() {}, async releaseFulfillmentReservations() {},
    async reversePromotionRedemption() { reversed = true; }, async insertStatusHistory() {},
    async insertAudit() {}, async insertOutbox() {}, async getOrder() { return { order: { id: orderId, status: "CANCELLED" } }; }
  } });
  await service.transitionOrder(tenantId, orderId, { status: "CANCELLED", reasonCode: "CUSTOMER_REQUEST",
    notes: "Customer requested cancellation" }, context);
  assert.equal(reversed, true);
});

test("manual order creation enforces product quantity steps", async () => {
  const service = createOrdersService({ transaction, dao: {
    async findStoreContext() { return { id: "store", currency: "INR" }; },
    async findOffersForOrder() { return [{ id: "offer", merchantId: "merchant",
      variantId: "variant", productName: "Apples", vertical: "GROCERY",
      hsnSacCode: "0808", taxCategoryId: "tax-category", taxRateId: "tax-rate",
      registrationGstin: "29ABCDE1234F1Z5", registrationStateCode: "29",
      cgstRate: 2.5, sgstRate: 2.5, igstRate: 5, cessRate: 0, cessAmount: 0,
      soldByWeight: true, minimumOrderQuantity: 0.25, maximumOrderQuantity: 5,
      quantityStep: 0.05, estimatedWeight: 1, listPrice: 240, salePrice: 199 }]; }
  } });
  await assert.rejects(() => service.createOrder(tenantId, {
    storeId: "store", customer: {}, shippingAddress: { stateCode: "KA" }, deliverySlotId: null,
    items: [{ offerId: "offer", quantity: 0.27, substitutionPreference: "CONTACT_ME" }]
  }, context), (error) => error.code === "ORDER_QUANTITY_STEP_INVALID" && error.status === 422);
});

test("manual order creation snapshots IGST for an inter-state supply", async () => {
  let insertedItem;
  const service = createOrdersService({ transaction, dao: {
    async findStoreContext() { return { id: "store", currency: "INR" }; },
    async findOffersForOrder() { return [{ id: "offer", merchantId: "merchant",
      variantId: "variant", merchantName: "Seller", productName: "Headphones",
      variantName: "Black", sku: "HEADPHONE-BLK", hsnSacCode: "8518", vertical: "ELECTRONICS",
      soldByWeight: false, minimumOrderQuantity: 1, maximumOrderQuantity: 5,
      quantityStep: 1, estimatedWeight: 0.5, listPrice: 1180, salePrice: 1180,
      taxCategoryId: "tax-category", taxRateId: "tax-rate", registrationGstin: "27ABCDE1234F1Z5",
      registrationStateCode: "27", cgstRate: 9, sgstRate: 9, igstRate: 18,
      cessRate: 0, cessAmount: 0 }]; },
    async findCustomer() { return { id: "customer" }; },
    async nextDocumentNumber({ type }) { return `${type}-1`; },
    async insertOrder() {}, async insertSellerOrder() {},
    async insertOrderItem({ item }) { insertedItem = item; },
    async insertStatusHistory() {}, async insertAudit() {}, async insertOutbox() {},
    async getOrder() { return { order: { id: orderId, grandTotal: 1180 } }; }
  } });
  await service.createOrder(tenantId, {
    storeId: "store", customer: { firstName: "Ananya", email: "a@example.in", phone: "" },
    shippingAddress: { line1: "42 Market Road", city: "Bengaluru", stateCode: "KA",
      stateName: "Karnataka", postalCode: "560001" },
    deliverySlotId: null, items: [{ offerId: "offer", quantity: 1 }],
    customerNotes: "", internalNotes: ""
  }, context);
  assert.equal(insertedItem.taxableAmount, "1000.0000");
  assert.equal(insertedItem.cgstAmount, "0.0000");
  assert.equal(insertedItem.sgstAmount, "0.0000");
  assert.equal(insertedItem.igstAmount, "180.0000");
  assert.equal(insertedItem.taxTotal, "180.0000");
  assert.equal(insertedItem.productSnapshot.tax.supplyType, "INTER_STATE");
});

test("manual order creation rejects products without an effective GST rate", async () => {
  const service = createOrdersService({ transaction, dao: {
    async findStoreContext() { return { id: "store", currency: "INR" }; },
    async findOffersForOrder() { return [{ id: "offer", merchantId: "merchant",
      variantId: "variant", merchantName: "Seller", productName: "Unconfigured product",
      hsnSacCode: "9999", taxCategoryId: "tax-category", taxRateId: null }]; }
  } });
  await assert.rejects(() => service.createOrder(tenantId, {
    storeId: "store", customer: {}, shippingAddress: { stateCode: "KA" },
    deliverySlotId: null, items: [{ offerId: "offer", quantity: 1 }]
  }, context), (error) => error.code === "ORDER_TAX_RATE_MISSING" && error.status === 422);
});

test("fulfilment allocation reserves stock and creates an operational record", async () => {
  const calls = [];
  const service = createOrdersService({ transaction, dao: {
    async findSellerOrderForFulfillment() { return { id: "seller", merchantId: "merchant",
      fulfillmentStatus: "UNFULFILLED", orderStatus: "CONFIRMED", storeId: "store",
      hasFulfillment: false, items: [{ id: "item", offerId: "offer", productName: "Shirt",
        quantity: 2, lotTracking: false, serialTracking: false }] }; },
    async findWarehouseForFulfillment() { return { id: "warehouse", name: "Central Warehouse" }; },
    async findBalanceForFulfillment() { return { id: "balance", onHandQuantity: 10,
      reservedQuantity: 1, quarantineQuantity: 0 }; },
    async insertFulfillment() { calls.push("fulfillment"); },
    async insertFulfillmentItem() { calls.push("item"); },
    async reserveFulfillmentStock({ reservation }) { calls.push(["reserve", reservation.quantity]); },
    async markFulfillmentAllocated() { calls.push("allocated"); },
    async insertStatusHistory() { calls.push("history"); },
    async insertAudit() { calls.push("audit"); },
    async insertOutbox() { calls.push("outbox"); },
    async getOrder() { return { order: { id: orderId, status: "PROCESSING" }, fulfillments: [{}] }; }
  } });
  const result = await service.allocateFulfillment(tenantId, orderId, {
    sellerOrderId: "seller", warehouseId: "warehouse", serialAssignments: [], notes: ""
  }, context);
  assert.equal(result.order.status, "PROCESSING");
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "reserve" && call[1] === "2"));
  assert.deepEqual(calls.filter((call) => typeof call === "string"),
    ["fulfillment", "item", "allocated", "history", "audit", "outbox"]);
});

test("fulfilment allocation rejects insufficient warehouse stock", async () => {
  const service = createOrdersService({ transaction, dao: {
    async findSellerOrderForFulfillment() { return { id: "seller", merchantId: "merchant",
      fulfillmentStatus: "UNFULFILLED", orderStatus: "CONFIRMED", storeId: "store",
      hasFulfillment: false, items: [{ id: "item", offerId: "offer", productName: "Television",
        quantity: 2, lotTracking: false, serialTracking: false }] }; },
    async findWarehouseForFulfillment() { return { id: "warehouse", name: "Central Warehouse" }; },
    async findBalanceForFulfillment() { return { id: "balance", onHandQuantity: 2,
      reservedQuantity: 1, quarantineQuantity: 0 }; },
    async insertFulfillment() {}
  } });
  await assert.rejects(() => service.allocateFulfillment(tenantId, orderId, {
    sellerOrderId: "seller", warehouseId: "warehouse", serialAssignments: [], notes: ""
  }, context), (error) => error.code === "FULFILLMENT_STOCK_SHORTAGE" && error.status === 409);
});

test("bundle fulfilment reserves component stock against the parent order line", async () => {
  let insertedItem; let reserved;
  const service = createOrdersService({ transaction, dao: {
    async findSellerOrderForFulfillment() { return { id: "seller", merchantId: "merchant",
      fulfillmentStatus: "UNFULFILLED", orderStatus: "CONFIRMED", storeId: "store",
      hasFulfillment: false, items: [{ id: "component-snapshot", allocationId: "component-snapshot",
        orderItemId: "bundle-order-item", bundleComponentId: "component-snapshot",
        offerId: "component-offer", productName: "Charging cable", quantity: 2,
        lotTracking: false, serialTracking: false }] }; },
    async findWarehouseForFulfillment() { return { id: "warehouse", name: "Central Warehouse" }; },
    async findBalanceForFulfillment() { return { id: "balance", onHandQuantity: 8,
      reservedQuantity: 0, quarantineQuantity: 0 }; },
    async insertFulfillment() {},
    async insertFulfillmentItem({ item }) { insertedItem = item; },
    async reserveFulfillmentStock({ reservation }) { reserved = reservation; },
    async markFulfillmentAllocated() {}, async insertStatusHistory() {}, async insertAudit() {},
    async insertOutbox() {}, async getOrder() { return { order: { id: orderId } }; }
  } });
  await service.allocateFulfillment(tenantId, orderId, { sellerOrderId: "seller",
    warehouseId: "warehouse", serialAssignments: [], notes: "" }, context);
  assert.equal(insertedItem.orderItemId, "bundle-order-item");
  assert.equal(insertedItem.bundleComponentId, "component-snapshot");
  assert.equal(insertedItem.quantity, "2");
  assert.equal(reserved.quantity, "2");
});

test("fulfilment lifecycle enforces sequential picking and packing", async () => {
  const calls = [];
  const service = createOrdersService({ transaction, dao: {
    async findFulfillmentForUpdate() { return { id: "fulfillment", status: "PENDING",
      sellerOrderId: "seller", orderFulfillmentStatus: "PROCESSING" }; },
    async updateFulfillmentStage({ status }) { calls.push(["stage", status]); },
    async updateFulfillmentOrderItems({ status }) { calls.push(["items", status]); },
    async insertStatusHistory() { calls.push("history"); },
    async insertAudit() { calls.push("audit"); },
    async insertOutbox() { calls.push("outbox"); },
    async getOrder() { return { order: { id: orderId }, fulfillments: [{ status: "PICKING" }] }; }
  } });
  const result = await service.transitionFulfillment(tenantId, orderId, "fulfillment",
    { status: "PICKING", notes: "", location: "" }, context);
  assert.equal(result.fulfillments[0].status, "PICKING");
  assert.deepEqual(calls.slice(0, 2), [["stage", "PICKING"], ["items", "PICKING"]]);
});
