import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const offerId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const merchantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const storeId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b44";
const variantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b33";
const priceListId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b22";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) }); next();
}
function allow() { return (_req, _res, next) => next(); }
function service(overrides = {}) {
  return {
    async listOffers(_tenantId, filters) { return { items: [], total: 0, page: filters.page,
      pageSize: filters.pageSize, totalPages: 1, summary: {} }; },
    async listOptions() { return { merchants: [], variants: [], priceLists: [] }; },
    async getOffer() { return { id: offerId }; },
    async createOffer(_tenantId, input) { return { id: offerId, ...input }; },
    async updateOffer(_tenantId, _id, input) { return { id: offerId, ...input }; },
    async listPriceLists() { return []; },
    async createPriceList(_tenantId, input) { return { id: priceListId, ...input }; },
    async updatePriceList(_tenantId, _id, input) { return { id: priceListId, ...input }; },
    ...overrides
  };
}
function app(offersService = service()) {
  return createApp({ offersService, tenantAccessResolver: resolveTenant, tenantPermissionAuthorization: allow });
}

test("seller offer routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/offers");
  assert.equal(response.status, 401); assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("offer directory normalizes filters and pagination", async () => {
  let received;
  const response = await request(app(service({ async listOffers(receivedTenant, filters) {
    received = { tenantId: receivedTenant, filters }; return { items: [], total: 0, page: filters.page,
      pageSize: filters.pageSize, totalPages: 1, summary: {} };
  } }))).get(`/api/admin/v1/offers?search=Nova&status=active&merchantType=vendor&storeId=${storeId}&page=2&pageSize=10`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual({ ...received, filters: { ...received.filters } }, { tenantId, filters: { search: "Nova", status: "ACTIVE",
    merchantType: "VENDOR", storeId, page: 2, pageSize: 10 } });
});

test("offer creation normalizes commercial fields", async () => {
  let received;
  const response = await request(app(service({ async createOffer(receivedTenant, input) {
    received = { tenantId: receivedTenant, input }; return { id: offerId, ...input };
  } }))).post("/api/admin/v1/offers").set("authorization", `Bearer ${token}`).send({
    merchantId, storeId, variantId, priceListId, sellerSku: " seller-nova-14 ",
    fulfillmentType: "platform", handlingTimeHours: 12, listPrice: 74990, salePrice: 72990
  });
  assert.equal(response.status, 201); assert.equal(received.tenantId, tenantId);
  assert.equal(received.input.sellerSku, "SELLER-NOVA-14"); assert.equal(received.input.status, "DRAFT");
  assert.equal(received.input.fulfillmentType, "PLATFORM"); assert.equal(received.input.costPrice, null);
});

test("offer creation rejects selling price above MRP", async () => {
  const response = await request(app()).post("/api/admin/v1/offers").set("authorization", `Bearer ${token}`).send({
    merchantId, storeId, variantId, priceListId, sellerSku: "NOVA-14", listPrice: 70000, salePrice: 71000
  });
  assert.equal(response.status, 422); assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("price list creation keeps India-first INR settings", async () => {
  let input;
  const response = await request(app(service({ async createPriceList(_tenantId, value) {
    input = value; return { id: priceListId, currency: "INR", ...value };
  } }))).post("/api/admin/v1/price-lists").set("authorization", `Bearer ${token}`).send({
    code: " festive_store ", name: " Festive store pricing ", storeId, priority: 20, includesTax: true
  });
  assert.equal(response.status, 201); assert.equal(input.code, "FESTIVE_STORE");
  assert.equal(response.body.data.currency, "INR"); assert.equal(input.status, "ACTIVE");
});
