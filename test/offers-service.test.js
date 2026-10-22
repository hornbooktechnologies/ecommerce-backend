import assert from "node:assert/strict";
import test from "node:test";
import { createOffersService } from "../src/modules/offers/offers.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const merchantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const storeId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b44";
const variantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b33";
const priceListId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b22";
const context = { actorUserId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77", requestId: "request-1" };

function setup(overrides = {}) {
  const calls = { offers: [], prices: [], audits: [], closed: [] };
  const stored = { id: "018f47f2-6b6d-7c34-ae31-8f4f17b79b66", merchantId, merchantStatus: "ACTIVE", storeId, variantId,
    priceListId, status: "DRAFT", listPrice: 1000, salePrice: 900, costPrice: 700,
    minimumOrderQuantity: 1, maximumOrderQuantity: 10 };
  const dao = {
    async findOfferContext() { return { merchantStatus: "ACTIVE", merchantType: "VENDOR",
      taxCategoryId: null, priceListStatus: "ACTIVE", priceListStoreId: null }; },
    async findDuplicateOffer() { return null; },
    async insertOffer(input) { calls.offers.push(input); },
    async insertOfferPrice(input) { calls.prices.push(input); },
    async getOffer() { return stored; },
    async updateOffer(input) { calls.offers.push(input); },
    async closeOfferPrices(input) { calls.closed.push(input); },
    async insertAudit(input) { calls.audits.push(input); },
    ...overrides
  };
  return { calls, service: createOffersService({ dao, transaction: async (_tenant, operation) => operation({}) }) };
}

test("creates a seller offer and its initial price atomically", async () => {
  const { calls, service } = setup();
  const result = await service.createOffer(tenantId, { merchantId, storeId, variantId, priceListId,
    sellerSku: "SELLER-SKU", status: "DRAFT", fulfillmentType: "MERCHANT", handlingTimeHours: 24,
    minimumOrderQuantity: 1, maximumOrderQuantity: 5, listPrice: 1000, salePrice: 900, costPrice: 700 }, context);
  assert.equal(result.status, "DRAFT"); assert.equal(calls.offers.length, 1); assert.equal(calls.prices.length, 1);
  assert.equal(calls.prices[0].price.priceListId, priceListId); assert.equal(calls.audits.length, 1);
});

test("rejects a duplicate offer within merchant and store scope", async () => {
  const { service } = setup({ async findDuplicateOffer() { return "duplicate"; } });
  await assert.rejects(() => service.createOffer(tenantId, { merchantId, storeId, variantId, priceListId,
    sellerSku: "SELLER-SKU", status: "ACTIVE", fulfillmentType: "MERCHANT", handlingTimeHours: 24,
    minimumOrderQuantity: null, maximumOrderQuantity: null, listPrice: 1000, salePrice: 900, costPrice: null }, context),
  (error) => error.code === "OFFER_EXISTS" && error.status === 409);
});

test("price changes close the previous period and append a new price", async () => {
  const { calls, service } = setup();
  const result = await service.updateOffer(tenantId, "018f47f2-6b6d-7c34-ae31-8f4f17b79b66",
    { listPrice: 1100, salePrice: 950 }, context);
  assert.equal(result.id, "018f47f2-6b6d-7c34-ae31-8f4f17b79b66");
  assert.equal(calls.closed.length, 1); assert.equal(calls.prices.length, 1);
  assert.equal(calls.prices[0].price.salePrice, 950); assert.equal(calls.prices[0].price.costPrice, 700);
});

test("a suspended merchant offer cannot be reactivated", async () => {
  const { service } = setup({ async getOffer() { return { id: "offer", merchantStatus: "SUSPENDED",
    priceListId, listPrice: 1000, salePrice: 900, costPrice: 700 }; } });
  await assert.rejects(() => service.updateOffer(tenantId, "018f47f2-6b6d-7c34-ae31-8f4f17b79b66",
    { status: "ACTIVE" }, context), (error) => error.code === "MERCHANT_INACTIVE" && error.status === 409);
});
