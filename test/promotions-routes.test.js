import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const promotionId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const couponId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) }); next();
}
function allow() { return (_req, _res, next) => next(); }
function service(overrides = {}) {
  return { async listPromotions(_tenantId, filters) { return { items: [], total: 0, page: filters.page,
    pageSize: filters.pageSize, totalPages: 1, summary: {} }; }, async listOptions() { return { stores: [] }; },
  async getPromotion() { return { promotion: { id: promotionId }, coupons: [], redemptions: [] }; },
  async createPromotion(_tenantId, input) { return { promotion: { id: promotionId, ...input }, coupons: [], redemptions: [] }; },
  async updatePromotion(_tenantId, _id, input) { return { promotion: { id: promotionId, ...input }, coupons: [], redemptions: [] }; },
  async transitionPromotion(_tenantId, _id, status) { return { promotion: { id: promotionId, status }, coupons: [], redemptions: [] }; },
  async createCoupon() { return { promotion: { id: promotionId }, coupons: [{ id: couponId }], redemptions: [] }; },
  async updateCoupon() { return { promotion: { id: promotionId }, coupons: [{ id: couponId }], redemptions: [] }; },
  async previewPromotion() { return { eligible: true, discountAmount: 100 }; }, ...overrides };
}
function app(promotionsService = service()) { return createApp({ promotionsService,
  tenantAccessResolver: resolveTenant, tenantPermissionAuthorization: allow }); }

test("promotion routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/promotions");
  assert.equal(response.status, 401); assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("promotion directory normalizes filters", async () => {
  let received;
  const response = await request(app(service({ async listPromotions(receivedTenant, filters) {
    received = { tenantId: receivedTenant, filters }; return { items: [], total: 0, page: filters.page,
      pageSize: filters.pageSize, totalPages: 1, summary: {} };
  } }))).get("/api/admin/v1/promotions?search=Festive&status=active&type=percentage&page=2&pageSize=10")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual({ ...received, filters: { ...received.filters } }, { tenantId, filters: { search: "Festive", status: "ACTIVE",
    type: "PERCENTAGE", page: 2, pageSize: 10 } });
});

test("promotion creation validates and normalizes rules", async () => {
  let received;
  const response = await request(app(service({ async createPromotion(receivedTenant, input) {
    received = { tenantId: receivedTenant, input }; return { promotion: { id: promotionId }, coupons: [], redemptions: [] };
  } }))).post("/api/admin/v1/promotions").set("authorization", `Bearer ${token}`).send({
    name: " Festive 10 ", type: "percentage", storeId: null, startsAt: "2026-10-16T10:00:00.000Z",
    endsAt: "2026-10-20T10:00:00.000Z", discountValue: 10, minimumOrderAmount: 500,
    usageLimitTotal: 100, usageLimitPerCustomer: 1, couponRequired: true
  });
  assert.equal(response.status, 201); assert.equal(received.tenantId, tenantId);
  assert.equal(received.input.name, "Festive 10"); assert.equal(received.input.type, "PERCENTAGE");
  assert.equal(received.input.stackable, false); assert.equal(received.input.couponRequired, true);
});

test("invalid percentage promotions are rejected", async () => {
  const response = await request(app()).post("/api/admin/v1/promotions").set("authorization", `Bearer ${token}`).send({
    name: "Invalid discount", type: "PERCENTAGE", startsAt: "2026-10-16T10:00:00.000Z", discountValue: 150
  });
  assert.equal(response.status, 422); assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("coupon update route remains promotion scoped", async () => {
  let received;
  const response = await request(app(service({ async updateCoupon(receivedTenant, receivedPromotion, receivedCoupon, input) {
    received = { receivedTenant, receivedPromotion, receivedCoupon, input }; return { promotion: { id: promotionId }, coupons: [], redemptions: [] };
  } }))).patch(`/api/admin/v1/promotions/${promotionId}/coupons/${couponId}`)
    .set("authorization", `Bearer ${token}`).send({ code: " festive-10 ", status: "inactive", usageLimit: 20 });
  assert.equal(response.status, 200); assert.deepEqual(received, { receivedTenant: tenantId,
    receivedPromotion: promotionId, receivedCoupon: couponId,
    input: { code: "FESTIVE-10", status: "INACTIVE", usageLimit: 20, startsAt: null, endsAt: null } });
});

test("preview input accepts INR order values", async () => {
  let input;
  const response = await request(app(service({ async previewPromotion(_tenant, _promotion, value) { input = value; return { eligible: true }; } })))
    .post(`/api/admin/v1/promotions/${promotionId}/preview`).set("authorization", `Bearer ${token}`)
    .send({ subtotal: 1499.5, shippingAmount: 49, couponCode: "festive-10" });
  assert.equal(response.status, 200); assert.deepEqual(input, { subtotal: 1499.5, shippingAmount: 49, couponCode: "FESTIVE-10" });
});
