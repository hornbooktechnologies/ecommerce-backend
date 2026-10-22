import assert from "node:assert/strict";
import test from "node:test";
import { createCatalogService } from "../src/modules/catalog/catalog.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const productId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const context = {
  actorUserId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b66",
  requestId: "catalog-service-test",
  ipAddress: null,
  userAgent: "test"
};

function serviceWith({ product = {}, dependencies = {}, calls = {} } = {}) {
  const dao = {
    async findProductDetail() {
      return {
        id: productId, productCode: "TEST-01", name: "Test product",
        approvalStatus: "DRAFT", publicationStatus: "DRAFT", ...product
      };
    },
    async findProductDependencies() {
      return { orderItems: 0, inventoryBalances: 0, purchaseItems: 0,
        receiptItems: 0, transferItems: 0, ...dependencies };
    },
    async findProductPublicationReadiness() {
      return { hasCategory: true, hasTaxCategory: true, hasHsnSacCode: true,
        variantCount: 2, pricedVariantCount: 2 };
    },
    async updateProductWorkflow(input) { calls.workflow = input; },
    async insertAudit() { calls.audit = (calls.audit || 0) + 1; },
    async insertOutbox() { calls.outbox = (calls.outbox || 0) + 1; },
    async softDeleteProduct() { calls.deleted = (calls.deleted || 0) + 1; }
  };
  return createCatalogService({ dao, transaction: async (_tenantId, work) => work({}) });
}

test("draft products without commerce history are soft deleted", async () => {
  const calls = {};
  await serviceWith({ calls }).deleteProduct(tenantId, productId, context);
  assert.deepEqual(calls, { audit: 1, outbox: 1, deleted: 1 });
});

test("products with inventory history cannot be deleted", async () => {
  const calls = {};
  await assert.rejects(
    serviceWith({ dependencies: { inventoryBalances: 1 }, calls })
      .deleteProduct(tenantId, productId, context),
    (error) => error.code === "PRODUCT_HAS_COMMERCE_HISTORY" && error.status === 409
  );
  assert.equal(calls.deleted, undefined);
});

test("approved products must be archived instead of deleted", async () => {
  const calls = {};
  await assert.rejects(
    serviceWith({ product: { approvalStatus: "APPROVED", publicationStatus: "PUBLISHED" }, calls })
      .deleteProduct(tenantId, productId, context),
    (error) => error.code === "PRODUCT_DELETE_NOT_ALLOWED" && error.status === 409
  );
  assert.equal(calls.deleted, undefined);
});

test("ready draft products can enter the approval queue", async () => {
  const calls = {};
  const result = await serviceWith({ calls }).transitionProduct(
    tenantId, productId, "submit", context
  );
  assert.equal(result.product.approvalStatus, "PENDING");
  assert.equal(result.product.publicationStatus, "DRAFT");
  assert.equal(calls.workflow.offerStatus, "PENDING");
  assert.equal(calls.audit, 1);
  assert.equal(calls.outbox, 1);
});

test("rejected products retain the reviewer change request", async () => {
  const calls = {};
  const result = await serviceWith({
    product: { approvalStatus: "PENDING" }, calls
  }).transitionProduct(tenantId, productId, "reject", context, {
    note: "Add the missing compliance image."
  });
  assert.equal(result.product.approvalStatus, "REJECTED");
  assert.equal(calls.workflow.approvalNote, "Add the missing compliance image.");
  assert.equal(calls.workflow.offerStatus, "DRAFT");
});

test("products without complete catalog data cannot be submitted", async () => {
  const calls = {};
  const dao = {
    async findProductDetail() {
      return { id: productId, productCode: "TEST-01", approvalStatus: "DRAFT",
        publicationStatus: "DRAFT" };
    },
    async findProductPublicationReadiness() {
      return { hasCategory: false, hasTaxCategory: true, hasHsnSacCode: false,
        variantCount: 2, pricedVariantCount: 1 };
    },
    async updateProductWorkflow() { calls.workflow = true; },
    async insertAudit() {},
    async insertOutbox() {}
  };
  const service = createCatalogService({ dao,
    transaction: async (_tenantId, work) => work({}) });
  await assert.rejects(
    service.transitionProduct(tenantId, productId, "submit", context),
    (error) => error.code === "PRODUCT_NOT_READY" && error.details.length === 3
  );
  assert.equal(calls.workflow, undefined);
});

function verticalAwareCatalogService(enabledVerticals) {
  const insertedTypes = [];
  const lookup = () => ({
    productTypes: insertedTypes.map((vertical, index) => ({ id: `type-${index}`, code: vertical, vertical })),
    units: [{ id: "unit", code: "EA" }], brands: [], categories: [],
    taxCategories: [{ id: "tax" }], colors: [], sizes: []
  });
  const dao = {
    async listEnabledVerticals() { return enabledVerticals; },
    async listLookups() { return lookup(); },
    async findEnabledProductType({ vertical }) {
      return enabledVerticals.includes(vertical)
        ? { id: "type-enabled", code: vertical, vertical }
        : null;
    },
    async listMasters() { return [{ id: "existing" }]; },
    async insertProductType({ type }) { insertedTypes.push(type.vertical); },
    async insertUnit() {},
    async findAttributeDefinition() { return { id: "attribute" }; },
    async findDefaultCommerceScope() { return null; },
    async findDefaultPriceList() { return null; }
  };
  return {
    insertedTypes,
    service: createCatalogService({ dao, transaction: async (_tenantId, work) => work({}) })
  };
}

test("catalog defaults create only tenant-enabled product types", async () => {
  const { insertedTypes, service } = verticalAwareCatalogService(["GROCERY"]);
  const result = await service.ensureDefaults(tenantId);
  assert.deepEqual(insertedTypes, ["GROCERY"]);
  assert.deepEqual(result.productTypes.map((item) => item.vertical), ["GROCERY"]);
});

test("product creation rejects a product type disabled for the tenant", async () => {
  const { service } = verticalAwareCatalogService(["GROCERY"]);
  await assert.rejects(
    () => service.createProduct(tenantId, { vertical: "ELECTRONICS" }, context),
    (error) => error.code === "PRODUCT_TYPE_NOT_ENABLED" && error.status === 422
  );
});
