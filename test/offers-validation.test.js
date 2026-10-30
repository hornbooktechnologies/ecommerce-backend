import assert from "node:assert/strict";
import test from "node:test";
import { createOfferSchema, updateOfferSchema } from "../src/modules/offers/offers.validators.js";

const options = { abortEarly: false, convert: true, stripUnknown: true };

test("partial offer updates contain only supplied fields", () => {
  for (const input of [{ status: "ACTIVE" }, { status: "INACTIVE" }, { salePrice: 950 },
    { handlingTimeHours: 12 }, { minimumOrderQuantity: 2 }, { costPrice: 0 }]) {
    const { value, error } = updateOfferSchema.validate(input, options);
    assert.ifError(error);
    assert.deepEqual(value, input);
  }
});

test("explicit null and empty values are retained for intentional clearing", () => {
  for (const inputValue of [null, ""]) {
    const input = { minimumOrderQuantity: inputValue, maximumOrderQuantity: inputValue, costPrice: inputValue };
    const { value, error } = updateOfferSchema.validate(input, options);
    assert.ifError(error);
    assert.deepEqual(value, input);
  }
});

test("empty or unknown-only partial updates are rejected", () => {
  for (const input of [{}, { unknown: true }]) {
    assert.ok(updateOfferSchema.validate(input, options).error);
  }
});

test("invalid quantities and cost remain rejected", () => {
  for (const input of [{ minimumOrderQuantity: 0 }, { maximumOrderQuantity: -1 }, { costPrice: -1 }]) {
    assert.ok(updateOfferSchema.validate(input, options).error);
  }
});

test("creation retains nullable defaults", () => {
  const fixtureId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
  const { value, error } = createOfferSchema.validate({ merchantId: fixtureId, storeId: fixtureId,
    variantId: fixtureId, priceListId: fixtureId, sellerSku: "CREATE-DEFAULTS", listPrice: 1000, salePrice: 900 }, options);
  assert.ifError(error);
  assert.equal(value.minimumOrderQuantity, null);
  assert.equal(value.maximumOrderQuantity, null);
  assert.equal(value.costPrice, null);
  assert.equal(value.status, "DRAFT");
});
