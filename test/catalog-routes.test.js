import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const unitId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) });
  next();
}

function allow() { return (_req, _res, next) => next(); }

function service(overrides = {}) {
  return {
    async ensureDefaults() { return { productTypes: [], units: [], brands: [], categories: [], taxCategories: [] }; },
    async listProducts(_tenantId, input) { return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 1, summary: {} }; },
    async createProduct(_tenantId, input) { return { id: userId, productCode: input.productCode, name: input.name, status: "DRAFT" }; },
    async getProductVariants() { return { product: { id: userId }, scope: {}, variants: [] }; },
    async listProductMedia() { return { product: { id: userId }, variants: [], items: [], storageMode: "MANAGED_UPLOAD" }; },
    async addProductMedia(_tenantId, _productId, input) { return { product: { id: userId }, variants: [], items: [{ id: unitId, url: input.url }], storageMode: "MANAGED_UPLOAD" }; },
    async uploadProductMedia(_tenantId, _productId, input, file) { return { product: { id: userId }, variants: [], items: [{ id: unitId, altText: input.altText, byteSize: file.buffer.length }], storageMode: "MANAGED_UPLOAD" }; },
    async updateProductMedia(_tenantId, _productId, _mediaId, input) { return { product: { id: userId }, variants: [], items: [{ id: unitId, ...input }], storageMode: "MANAGED_UPLOAD" }; },
    async replaceProductMediaFile(_tenantId, _productId, _mediaId, input, file) { return { product: { id: userId }, variants: [], items: [{ id: unitId, altText: input.altText, byteSize: file.buffer.length }], storageMode: "MANAGED_UPLOAD" }; },
    async primaryProductMedia() { return { product: { id: userId }, variants: [], items: [] }; },
    async reorderProductMedia() { return { product: { id: userId }, variants: [], items: [] }; },
    async removeProductMedia() { return { product: { id: userId }, variants: [], items: [] }; },
    async updateProduct(_tenantId, productId, input) { return { product: { id: productId, ...input }, scope: {}, variants: [] }; },
    async updateProductPrices() { return { product: { id: userId }, scope: {}, variants: [] }; },
    async transitionProduct(_tenantId, productId, action) { return { product: { id: productId, publicationStatus: action === "archive" ? "ARCHIVED" : "DRAFT" }, scope: {}, variants: [] }; },
    async deleteProduct() {},
    async listMasters() { return []; },
    async createMaster(_tenantId, masterType, input) { return { id: userId, masterType, ...input, status: "ACTIVE" }; },
    async updateMaster(_tenantId, masterType, itemId, input) { return { id: itemId, masterType, ...input }; },
    async listInventory(_tenantId, input) { return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 1, summary: {} }; },
    ...overrides
  };
}

function app(catalogService = service()) {
  return createApp({ catalogService, tenantAccessResolver: resolveTenant, tenantPermissionAuthorization: allow });
}

test("catalog routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/catalog/products");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("product directory normalizes tenant filters", async () => {
  let received;
  const response = await request(app(service({
    async listProducts(receivedTenantId, input) {
      received = { tenantId: receivedTenantId, input };
      return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 1, summary: {} };
    }
  }))).get("/api/admin/v1/catalog/products?vertical=grocery&status=draft&page=2&pageSize=10")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.equal(received.tenantId, tenantId);
  assert.deepEqual({ ...received.input }, { search: "", status: "DRAFT", vertical: "GROCERY", page: 2, pageSize: 10 });
});

test("product creation accepts grocery variable-weight controls", async () => {
  const response = await request(app()).post("/api/admin/v1/catalog/products")
    .set("authorization", `Bearer ${token}`)
    .send({
      productCode: "APPLE-01", name: "Royal gala apples", vertical: "GROCERY",
      variant: { sku: "APPLE-01-KG", baseUomId: unitId, sellingUomId: unitId,
        soldByWeight: true, minimumOrderQuantity: 0.25, quantityStep: 0.05,
        estimatedWeight: 1, minimumWeight: 0.25, maximumWeight: 5, weightStep: 0.05 }
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.product.status, "DRAFT");
});

test("product creation accepts bundle structure", async () => {
  let received;
  const response = await request(app(service({ async createProduct(_tenantId, input) { received = input;
    return { id: userId, productCode: input.productCode, name: input.name, productKind: input.productKind, status: "DRAFT" }; } })))
    .post("/api/admin/v1/catalog/products").set("authorization", `Bearer ${token}`).send({
      productCode: "GIFT-KIT-01", name: "Festival gift kit", productKind: "bundle", vertical: "GENERAL",
      variant: { sku: "GIFT-KIT-01-DEFAULT", baseUomId: unitId, sellingUomId: unitId }
    });
  assert.equal(response.status, 201); assert.equal(received.productKind, "BUNDLE");
  assert.equal(response.body.data.product.productKind, "BUNDLE");
});

test("product creation accepts separately priced color and size variants", async () => {
  let received;
  const response = await request(app(service({
    async createProduct(_tenantId, input) {
      received = input;
      return { id: userId, productCode: input.productCode, name: input.name,
        variantCount: input.variants.length, status: "DRAFT" };
    }
  }))).post("/api/admin/v1/catalog/products")
    .set("authorization", `Bearer ${token}`)
    .send({
      productCode: "TEE-01", name: "Core t-shirt", vertical: "CLOTHING",
      variants: [
        { sku: "TEE-01-BLK-M", name: "Black / M", baseUomId: unitId,
          sellingUomId: unitId, pricing: { listPrice: 999, salePrice: 799, costPrice: 420 } },
        { sku: "TEE-01-BLK-L", name: "Black / L", baseUomId: unitId,
          sellingUomId: unitId, pricing: { listPrice: 1049, salePrice: 849, costPrice: 450 } }
      ]
    });
  assert.equal(response.status, 201);
  assert.equal(received.variants.length, 2);
  assert.deepEqual(received.variants.map((variant) => variant.pricing.salePrice), [799, 849]);
});

test("product creation accepts typed custom specifications", async () => {
  let received;
  const response = await request(app(service({
    async createProduct(_tenantId, input) {
      received = input;
      return { id: userId, productCode: input.productCode, name: input.name,
        customFieldCount: input.customFields.length, status: "DRAFT" };
    }
  }))).post("/api/admin/v1/catalog/products")
    .set("authorization", `Bearer ${token}`)
    .send({
      productCode: "MONITOR-01", name: "Studio monitor", vertical: "ELECTRONICS",
      customFields: [
        { label: "Screen size", type: "NUMBER", value: "27" },
        { label: "HDR enabled", type: "BOOLEAN", value: true },
        { label: "Panel", type: "TEXT", value: " IPS " },
        { label: "Launch date", type: "DATE", value: "2026-10-13" }
      ],
      variant: { sku: "MONITOR-01-DEFAULT", baseUomId: unitId, sellingUomId: unitId }
    });
  assert.equal(response.status, 201);
  assert.equal(received.customFields[0].value, 27);
  assert.equal(received.customFields[1].value, true);
  assert.equal(received.customFields[2].value, "IPS");
  assert.equal(response.body.data.product.customFieldCount, 4);
});

test("custom specification names must be unique", async () => {
  const response = await request(app()).post("/api/admin/v1/catalog/products")
    .set("authorization", `Bearer ${token}`)
    .send({
      productCode: "BOTTLE-02", name: "Insulated bottle", vertical: "GENERAL",
      customFields: [
        { label: "Capacity", type: "TEXT", value: "1 litre" },
        { label: "capacity", type: "NUMBER", value: 1 }
      ],
      variant: { sku: "BOTTLE-02-DEFAULT", baseUomId: unitId, sellingUomId: unitId }
    });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("variant price updates are normalized and forwarded", async () => {
  let received;
  const response = await request(app(service({
    async updateProductPrices(receivedTenantId, productId, input) {
      received = { receivedTenantId, productId, input };
      return { product: { id: productId }, scope: { currency: "INR" }, variants: [] };
    }
  }))).put(`/api/admin/v1/catalog/products/${userId}/prices`)
    .set("authorization", `Bearer ${token}`)
    .send({ prices: [{ variantId: unitId, listPrice: "1299", salePrice: "999", costPrice: "600" }] });
  assert.equal(response.status, 200);
  assert.equal(received.receivedTenantId, tenantId);
  assert.deepEqual({ ...received.input.prices[0] }, {
    variantId: unitId, listPrice: 1299, salePrice: 999, costPrice: 600
  });
});

test("product details include editable product and variant data", async () => {
  const response = await request(app()).get(`/api/admin/v1/catalog/products/${userId}/variants`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.product.id, userId);
  assert.deepEqual(response.body.data.variants, []);
});

test("product media supports variant image management", async () => {
  const listed = await request(app()).get(`/api/admin/v1/catalog/products/${userId}/media`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.storageMode, "MANAGED_UPLOAD");

  const created = await request(app()).post(`/api/admin/v1/catalog/products/${userId}/media`)
    .set("authorization", `Bearer ${token}`)
    .send({ url: "https://images.example.com/product.jpg", altText: "Front view", variantId: unitId });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.items[0].url, "https://images.example.com/product.jpg");
});

test("product media accepts a binary image upload with gallery metadata", async () => {
  let received;
  const response = await request(app(service({
    async uploadProductMedia(receivedTenantId, productId, input, file) {
      received = { receivedTenantId, productId, input, file };
      return { product: { id: productId }, items: [{ id: unitId, altText: input.altText }] };
    }
  }))).post(`/api/admin/v1/catalog/products/${userId}/media/upload`)
    .query({ fileName: "blue-shirt.webp", altText: "Blue shirt front", colorOptionId: tenantId })
    .set("authorization", `Bearer ${token}`).set("content-type", "image/webp")
    .send(Buffer.from("product-image"));
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.fileName, "blue-shirt.webp");
  assert.equal(received.input.colorOptionId, tenantId);
  assert.equal(received.file.mimeType, "image/webp");
  assert.equal(received.file.buffer.toString(), "product-image");
});

test("product media replacement normalizes colour scope and alternative text", async () => {
  let received;
  const response = await request(app(service({
    async updateProductMedia(receivedTenantId, productId, mediaId, input) {
      received = { receivedTenantId, productId, mediaId, input };
      return { product: { id: productId }, variants: [], colors: [], items: [{ id: mediaId, ...input }] };
    }
  }))).patch(`/api/admin/v1/catalog/products/${userId}/media/${unitId}`)
    .set("authorization", `Bearer ${token}`).send({
      url: "https://images.example.com/replacement.jpg", altText: "Blue shirt, front view",
      colorOptionId: tenantId
    });
  assert.equal(response.status, 200);
  assert.deepEqual(received, { receivedTenantId: tenantId, productId: userId, mediaId: unitId,
    input: { url: "https://images.example.com/replacement.jpg", altText: "Blue shirt, front view",
      variantId: null, colorOptionId: tenantId } });
});

test("product details can be edited", async () => {
  let received;
  const response = await request(app(service({
    async updateProduct(receivedTenantId, productId, input) {
      received = { receivedTenantId, productId, input };
      return { product: { id: productId, ...input }, scope: {}, variants: [] };
    }
  }))).patch(`/api/admin/v1/catalog/products/${userId}`)
    .set("authorization", `Bearer ${token}`)
    .send({ name: "Updated product", countryOfOrigin: "in", isReturnable: true, returnWindowDays: 15 });
  assert.equal(response.status, 200);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.countryOfOrigin, "IN");
  assert.equal(received.input.returnWindowDays, 15);
});

test("products can be archived and safely deleted", async () => {
  const archive = await request(app()).post(`/api/admin/v1/catalog/products/${userId}/archive`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(archive.status, 200);
  assert.equal(archive.body.data.product.publicationStatus, "ARCHIVED");

  const deletion = await request(app()).delete(`/api/admin/v1/catalog/products/${userId}`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(deletion.status, 204);
});

test("product publication routes forward each lifecycle action", async () => {
  const received = [];
  const catalogService = service({
    async transitionProduct(receivedTenantId, receivedProductId, action, _context, input) {
      received.push({ receivedTenantId, receivedProductId, action, input });
      return { product: { id: receivedProductId, approvalStatus: "PENDING",
        publicationStatus: "DRAFT" } };
    }
  });
  for (const [action, body] of [
    ["submit", undefined], ["approve", { note: "Reviewed" }],
    ["reject", { note: "Add a clearer product image." }], ["publish", undefined]
  ]) {
    const operation = request(app(catalogService))
      .post(`/api/admin/v1/catalog/products/${userId}/${action}`)
      .set("authorization", `Bearer ${token}`);
    const response = body ? await operation.send(body) : await operation;
    assert.equal(response.status, 200);
  }
  assert.deepEqual(received.map((item) => item.action), ["submit", "approve", "reject", "publish"]);
  assert.equal(received[2].input.note, "Add a clearer product image.");
  assert.ok(received.every((item) => item.receivedTenantId === tenantId));
});

test("product rejection requires a useful change request", async () => {
  const response = await request(app()).post(`/api/admin/v1/catalog/products/${userId}/reject`)
    .set("authorization", `Bearer ${token}`)
    .send({ note: "Too short" });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("inventory health rejects unknown values", async () => {
  const response = await request(app()).get("/api/admin/v1/inventory?health=CRITICAL")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("catalog masters validate and create reusable color values", async () => {
  const response = await request(app()).post("/api/admin/v1/catalog/masters/colors")
    .set("authorization", `Bearer ${token}`)
    .send({ name: "Forest green", swatchValue: "#1f6d52" });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.item.masterType, "colors");
  assert.equal(response.body.data.item.name, "Forest green");
});

test("catalog masters reject unsupported master types", async () => {
  const response = await request(app()).get("/api/admin/v1/catalog/masters/materials")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});
