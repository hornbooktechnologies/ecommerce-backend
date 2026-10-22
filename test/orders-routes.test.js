import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const orderId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) });
  next();
}

function allow() { return (_req, _res, next) => next(); }

function service(overrides = {}) {
  return {
    async listCreationOptions() { return { stores: [], offers: [], deliverySlots: [] }; },
    async listOrders(_tenantId, filters) {
      return { items: [], total: 0, page: filters.page, pageSize: filters.pageSize,
        totalPages: 1, summary: {} };
    },
    async getOrder() { return { order: { id: orderId }, items: [], sellerOrders: [], history: [] }; },
    async createOrder(_tenantId, input) {
      return { order: { id: orderId, orderNumber: "ORD-000001", customerName: input.customer.firstName },
        items: [], sellerOrders: [], history: [] };
    },
    async transitionOrder(_tenantId, receivedOrderId, input) {
      return { order: { id: receivedOrderId, status: input.status }, items: [], sellerOrders: [], history: [] };
    },
    async getFulfillmentOptions() { return { order: { id: orderId }, sellerOrders: [], warehouses: [], inventory: [] }; },
    async allocateFulfillment() { return { order: { id: orderId }, fulfillments: [] }; },
    async transitionFulfillment() { return { order: { id: orderId }, fulfillments: [] }; },
    ...overrides
  };
}

function app(ordersService = service()) {
  return createApp({ ordersService, tenantAccessResolver: resolveTenant,
    tenantPermissionAuthorization: allow });
}

test("order routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/orders");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("order directory normalizes filters and pagination", async () => {
  let received;
  const response = await request(app(service({
    async listOrders(receivedTenantId, filters) {
      received = { receivedTenantId, filters };
      return { items: [], total: 0, page: filters.page, pageSize: filters.pageSize,
        totalPages: 1, summary: {} };
    }
  }))).get("/api/admin/v1/orders?status=placed&paymentStatus=paid&fulfillmentStatus=unfulfilled&page=2&pageSize=10")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.equal(received.receivedTenantId, tenantId);
  assert.deepEqual({ ...received.filters }, {
    search: "", status: "PLACED", paymentStatus: "PAID",
    fulfillmentStatus: "UNFULFILLED", page: 2, pageSize: 10
  });
});

test("order details remain tenant scoped", async () => {
  let received;
  const response = await request(app(service({
    async getOrder(receivedTenantId, receivedOrderId) {
      received = { receivedTenantId, receivedOrderId };
      return { order: { id: receivedOrderId }, items: [], sellerOrders: [], history: [] };
    }
  }))).get(`/api/admin/v1/orders/${orderId}`).set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual(received, { receivedTenantId: tenantId, receivedOrderId: orderId });
});

test("order lifecycle changes are normalized and forwarded", async () => {
  let received;
  const response = await request(app(service({
    async transitionOrder(receivedTenantId, receivedOrderId, input) {
      received = { receivedTenantId, receivedOrderId, input };
      return { order: { id: receivedOrderId, status: input.status }, items: [], sellerOrders: [], history: [] };
    }
  }))).patch(`/api/admin/v1/orders/${orderId}/status`)
    .set("authorization", `Bearer ${token}`)
    .send({ status: "confirmed", notes: "Validated by the operations desk" });
  assert.equal(response.status, 200);
  assert.equal(received.receivedTenantId, tenantId);
  assert.deepEqual({ ...received.input }, {
    status: "CONFIRMED", reasonCode: "", notes: "Validated by the operations desk"
  });
});

test("order cancellation requires an operator note", async () => {
  const response = await request(app()).patch(`/api/admin/v1/orders/${orderId}/status`)
    .set("authorization", `Bearer ${token}`).send({ status: "CANCELLED", notes: "" });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("manual order creation normalizes Indian address and grocery quantity", async () => {
  let received;
  const response = await request(app(service({
    async createOrder(receivedTenantId, input) {
      received = { receivedTenantId, input };
      return { order: { id: orderId, orderNumber: "ORD-000001" }, items: [], sellerOrders: [], history: [] };
    }
  }))).post("/api/admin/v1/orders")
    .set("authorization", `Bearer ${token}`)
    .send({
      storeId: userId,
      customer: { firstName: "Ananya", email: "ANANYA@EXAMPLE.IN" },
      shippingAddress: { line1: "42 Market Road", city: "Bengaluru", stateCode: "ka",
        stateName: "Karnataka", postalCode: "560001" },
      items: [{ offerId: userId, quantity: "0.5", substitutionPreference: "allow_similar" }]
    });
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.customer.email, "ananya@example.in");
  assert.equal(received.input.shippingAddress.stateCode, "KA");
  assert.equal(received.input.items[0].quantity, 0.5);
  assert.equal(received.input.items[0].substitutionPreference, "ALLOW_SIMILAR");
});

test("manual order creation requires customer contact details", async () => {
  const response = await request(app()).post("/api/admin/v1/orders")
    .set("authorization", `Bearer ${token}`)
    .send({ storeId: userId, customer: { firstName: "Ananya" },
      shippingAddress: { line1: "42 Market Road", city: "Bengaluru", stateCode: "KA",
        stateName: "Karnataka", postalCode: "560001" },
      items: [{ offerId: userId, quantity: 1 }] });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("fulfilment allocation normalizes serial assignments", async () => {
  let received;
  const response = await request(app(service({
    async allocateFulfillment(receivedTenantId, receivedOrderId, input) {
      received = { receivedTenantId, receivedOrderId, input };
      return { order: { id: receivedOrderId }, fulfillments: [] };
    }
  }))).post(`/api/admin/v1/orders/${orderId}/fulfillments`)
    .set("authorization", `Bearer ${token}`)
    .send({ sellerOrderId: userId, warehouseId: userId,
      serialAssignments: [{ orderItemId: userId, serialIds: [orderId] }], notes: "Allocate now" });
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.serialAssignments[0].serialIds[0], orderId);
});

test("dispatch requires carrier and tracking number", async () => {
  const response = await request(app()).patch(
    `/api/admin/v1/orders/${orderId}/fulfillments/${userId}/status`)
    .set("authorization", `Bearer ${token}`).send({ status: "dispatched" });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("fulfilment status changes normalize manual shipment data", async () => {
  let received;
  const response = await request(app(service({
    async transitionFulfillment(receivedTenantId, receivedOrderId, fulfillmentId, input) {
      received = { receivedTenantId, receivedOrderId, fulfillmentId, input };
      return { order: { id: receivedOrderId }, fulfillments: [{ id: fulfillmentId, status: input.status }] };
    }
  }))).patch(`/api/admin/v1/orders/${orderId}/fulfillments/${userId}/status`)
    .set("authorization", `Bearer ${token}`)
    .send({ status: "dispatched", providerCode: "delhivery", trackingNumber: "TRK-101",
      packageCount: "2", packageWeight: "1.25" });
  assert.equal(response.status, 200);
  assert.equal(received.input.status, "DISPATCHED");
  assert.equal(received.input.providerCode, "DELHIVERY");
  assert.equal(received.input.packageCount, 2);
});
