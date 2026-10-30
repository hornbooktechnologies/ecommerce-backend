import assert from "node:assert/strict";
import test from "node:test";
import { createCatalogService } from "../src/modules/catalog/catalog.service.js";

function fixture(overrides = {}) {
  const product = { id: "product", productCode: "TEST", name: "Original",
    slug: "original-test", productKind: "STANDARD", vertical: "GENERAL",
    publicationStatus: "PUBLISHED", approvalStatus: "APPROVED", ...overrides };
  const calls = {};
  const lookups = { productTypes: [{ code: "GENERAL", vertical: "GENERAL" }],
    units: ["EA", "KG", "G", "L", "ML"].map((code) => ({ code })),
    categories: [{ id: "category" }], taxCategories: [{ id: "tax" }], brands: [] };
  const dao = {
    async listEnabledVerticals() { return ["GENERAL"]; },
    async listLookups() { return lookups; },
    async listMasters() { return [{}]; },
    async findAttributeDefinition() { return {}; },
    async findDefaultCommerceScope() { return { storeId: "store", merchantId: "merchant" }; },
    async findDefaultPriceList() { return { id: "price" }; },
    async findProductDetail(args) { if (args.forUpdate) calls.locked = true; return product; },
    async updateProduct({ product: update }) { calls.update = update; Object.assign(product, update); },
    async replaceProductCategory() {},
    async listProductMediaDetails() { return []; },
    async clearProductMedia() {},
    async listProductImages() { return []; },
    async listProductCustomFields() { return []; },
    async listProductVariants() { return []; },
    async insertAudit() { calls.audit = true; },
    async insertOutbox() { calls.outbox = true; }
  };
  return { calls, product, service: createCatalogService({ dao,
    transaction: async (_tenant, work) => work({}) }) };
}
const input = { name: "Updated name", categoryId: "category", taxCategoryId: "tax",
  hsnSacCode: "6109", imageUrls: [], countryOfOrigin: "IN", isReturnable: true, returnWindowDays: 7 };
const context = { actorUserId: "editor", requestId: "published-edit-test" };

test("published edits keep URL, approval and publication while auditing the change", async () => {
  const { service, calls, product } = fixture();
  await service.updateProduct("tenant", "product", input, context);
  assert.equal(calls.locked, true);
  assert.equal(product.name, input.name);
  assert.equal(product.slug, "original-test");
  assert.equal(product.publicationStatus, "PUBLISHED");
  assert.equal(product.approvalStatus, "APPROVED");
  assert.equal(calls.update.productKind, undefined);
  assert.equal(calls.audit, true);
  assert.equal(calls.outbox, true);
});
for (const approvalStatus of ["PENDING", "APPROVED"]) {
  test(`${approvalStatus} draft cannot be edited around review`, async () => {
    const { service, calls } = fixture({ publicationStatus: "DRAFT", approvalStatus });
    await assert.rejects(service.updateProduct("tenant", "product", input, context),
      (error) => error.code === "PRODUCT_EDIT_NOT_ALLOWED");
    assert.equal(calls.update, undefined);
  });
}
for (const field of ["categoryId", "taxCategoryId", "hsnSacCode"]) {
  test(`published edits cannot clear ${field}`, async () => {
    const { service, calls } = fixture();
    await assert.rejects(service.updateProduct("tenant", "product", { ...input, [field]: "" }, context),
      (error) => error.code === "PRODUCT_NOT_READY");
    assert.equal(calls.update, undefined);
  });
}
test("published edits reject references from another tenant", async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.updateProduct("tenant", "product", { ...input, brandId: "foreign-brand" }, context),
    (error) => error.code === "INVALID_CATALOG_REFERENCE");
  assert.equal(calls.update, undefined);
});
test("archived and rejected products retain their existing URL during editing", async () => {
  for (const publicationStatus of ["ARCHIVED", "DRAFT"]) {
    const { service, product } = fixture({ publicationStatus, approvalStatus: "REJECTED" });
    await service.updateProduct("tenant", "product", input, context);
    assert.equal(product.slug, "original-test");
    assert.equal(product.publicationStatus, publicationStatus);
  }
});
