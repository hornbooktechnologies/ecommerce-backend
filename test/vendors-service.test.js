import assert from "node:assert/strict";
import test from "node:test";
import { createVendorsService } from "../src/modules/vendors/vendors.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const vendorId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const itemId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const context = { actorUserId: itemId, requestId: "req", ipAddress: "127.0.0.1", userAgent: "test" };
const transaction = (_tenantId, operation) => operation({});

test("vendor offer requires an approved vendor", async () => {
  const dao = {
    async findOfferContext() { return { merchantStatus: "PENDING", taxCategoryId: null, priceListId: itemId }; }
  };
  const service = createVendorsService({ dao, transaction });
  await assert.rejects(() => service.createVendorOffer(tenantId, vendorId, { storeId: itemId,
    variantId: itemId, sellerSku: "SKU", fulfillmentType: "MERCHANT", handlingTimeHours: 24,
    listPrice: 100, salePrice: 90, costPrice: 50 }, context),
  (error) => error.code === "VENDOR_APPROVAL_REQUIRED");
});

test("vendor offer rejects selling price above MRP", async () => {
  const service = createVendorsService({ dao: {}, transaction });
  await assert.rejects(() => service.createVendorOffer(tenantId, vendorId, { storeId: itemId,
    variantId: itemId, sellerSku: "SKU", fulfillmentType: "MERCHANT", handlingTimeHours: 24,
    listPrice: 100, salePrice: 101, costPrice: 50 }, context),
  (error) => error.code === "OFFER_PRICE_INVALID");
});
