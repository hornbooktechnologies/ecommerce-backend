import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const merchantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const sellerOrderId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveVendor(req, _res, next) {
  req.context = Object.freeze({ ...req.context, vendor: Object.freeze({ tenantId, merchantId,
    merchant: { id: merchantId, status: "ACTIVE" }, assignments: [] }) }); next();
}
function allow() { return (_req, _res, next) => next(); }
function service(overrides = {}) {
  return { async getWorkspace() { return {}; }, async updateProfile() { return {}; },
    async updateOffer() { return {}; },
    async listOrders(_tenantId, _merchantId, filters) { return { items: [], total: 0,
      page: filters.page, pageSize: filters.pageSize, totalPages: 1, summary: {} }; },
    async getOrder() { return { order: { id: sellerOrderId }, items: [], fulfillments: [], history: [] }; },
    async decideOrder() { return { order: { id: sellerOrderId, status: "CONFIRMED" } }; }, ...overrides };
}
function app(vendorPortalService = service()) {
  return createApp({ vendorPortalService, vendorAccessResolver: resolveVendor,
    vendorPermissionAuthorization: allow });
}

test("vendor portal routes require authentication", async () => {
  const response = await request(app()).get("/api/vendor/v1/orders");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("vendor order queue normalizes filters and uses authenticated merchant scope", async () => {
  let received;
  const response = await request(app(service({ async listOrders(receivedTenantId,
    receivedMerchantId, filters) { received = { receivedTenantId, receivedMerchantId, filters };
    return { items: [], total: 0, page: filters.page, pageSize: filters.pageSize,
      totalPages: 1, summary: {} }; } })))
    .get("/api/vendor/v1/orders?status=pending&fulfillmentStatus=unfulfilled&page=2&pageSize=10")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual({ ...received, filters: { ...received.filters } }, {
    receivedTenantId: tenantId, receivedMerchantId: merchantId,
    filters: { search: "", status: "PENDING", fulfillmentStatus: "UNFULFILLED",
      page: 2, pageSize: 10 } });
});

test("vendor order decision is normalized and merchant scoped", async () => {
  let received;
  const response = await request(app(service({ async decideOrder(receivedTenantId,
    receivedMerchantId, receivedSellerOrderId, input) {
    received = { receivedTenantId, receivedMerchantId, receivedSellerOrderId, input };
    return { order: { id: receivedSellerOrderId, status: "CANCELLED" } };
  } }))).post(`/api/vendor/v1/orders/${sellerOrderId}/decision`)
    .set("authorization", `Bearer ${token}`)
    .send({ action: "reject", reasonCode: "stock_unavailable", notes: "No usable stock" });
  assert.equal(response.status, 200);
  assert.deepEqual(received, { receivedTenantId: tenantId, receivedMerchantId: merchantId,
    receivedSellerOrderId: sellerOrderId, input: { action: "REJECT",
      reasonCode: "STOCK_UNAVAILABLE", notes: "No usable stock" } });
});

test("vendor rejection requires an operator note", async () => {
  const response = await request(app()).post(`/api/vendor/v1/orders/${sellerOrderId}/decision`)
    .set("authorization", `Bearer ${token}`).send({ action: "REJECT", notes: "" });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("vendor fulfillment options use authenticated merchant scope", async () => {
  let received;
  const response = await request(app(service({ async getFulfillmentOptions(receivedTenantId,
    receivedMerchantId, receivedSellerOrderId) {
    received = { receivedTenantId, receivedMerchantId, receivedSellerOrderId };
    return { sellerOrder: { id: receivedSellerOrderId }, warehouses: [], inventory: [] };
  } }))).get(`/api/vendor/v1/orders/${sellerOrderId}/fulfillment-options`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual(received, { receivedTenantId: tenantId, receivedMerchantId: merchantId,
    receivedSellerOrderId: sellerOrderId });
});

test("vendor fulfillment allocation normalizes traceability input", async () => {
  let received;
  const response = await request(app(service({ async allocateFulfillment(receivedTenantId,
    receivedMerchantId, receivedSellerOrderId, input) {
    received = { receivedTenantId, receivedMerchantId, receivedSellerOrderId, input };
    return { order: { id: receivedSellerOrderId } };
  } }))).post(`/api/vendor/v1/orders/${sellerOrderId}/fulfillments`)
    .set("authorization", `Bearer ${token}`).send({
      warehouseId: tenantId, notes: "Reserve vendor stock",
      serialAssignments: [{ orderItemId: userId, serialIds: [merchantId] }]
    });
  assert.equal(response.status, 201);
  assert.deepEqual(received, { receivedTenantId: tenantId, receivedMerchantId: merchantId,
    receivedSellerOrderId: sellerOrderId, input: { warehouseId: tenantId,
      notes: "Reserve vendor stock", serialAssignments: [{ orderItemId: userId,
        serialIds: [merchantId] }] } });
});

test("vendor dispatch requires carrier and tracking number", async () => {
  const response = await request(app()).patch(
    `/api/vendor/v1/orders/${sellerOrderId}/fulfillments/${userId}/status`)
    .set("authorization", `Bearer ${token}`).send({ status: "DISPATCHED" });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});
