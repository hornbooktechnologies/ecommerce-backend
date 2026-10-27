import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createStorefrontService } from "../src/modules/storefront/storefront.service.js";
import { listProducts } from "../src/modules/storefront/storefront.dao.js";

const base = "/api/storefront/v1/HORNBOOK_RETAIL/stores/MAIN";
const scope = { tenantId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b88", storeId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77", currency: "INR" };
test("public catalog is anonymous, validates filters and does not use caller tenant headers", async () => {
  let received;
  const app = createApp({ storefrontService: { async catalog(input, filters) { received = { input, filters }; return { items: [], total: 0 }; } } });
  const response = await request(app).get(`${base}/products?search=linen&page=2`).set("x-tenant-id", "another-tenant");
  assert.equal(response.status, 200); assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(received.input.tenantCode, "HORNBOOK_RETAIL"); assert.equal(received.input.storeCode, "MAIN");
  assert.equal(received.filters.pageSize, 10); assert.equal(received.filters.page, 2);
  for (const query of ["page=0", "pageSize=101", "sort=DROP", "brand=bad", "minPrice=200&maxPrice=1", "tenantId=other", "search=" + "x".repeat(191)]) {
    assert.equal((await request(app).get(`${base}/products?${query}`)).status, 422);
  }
  assert.equal((await request(app).get("/api/admin/v1/catalog/products")).status, 401);
});
test("unknown or inactive stores stop before product queries", async () => {
  const service = createStorefrontService({ dao: { async resolveStore() { return null; }, async listProducts() { assert.fail("Must not query products"); } } });
  await assert.rejects(() => service.catalog({}, {}), (error) => error.status === 404);
});
test("hidden products are not allowed to expose media or specifications", async () => {
  const service = createStorefrontService({ dao: { async resolveStore() { return scope; }, async findProduct() { return null; } }, media() { assert.fail("Must not read private media"); } });
  await assert.rejects(() => service.detail({}, "draft"), (error) => error.code === "PRODUCT_NOT_FOUND");
});
test("detail exposes only media for eligible variants/colours and whitelisted specifications", async () => {
  const service = createStorefrontService({ dao: { async resolveStore() { return scope; }, async findProduct() { return { id: "p", name: "Shirt" }; },
    async listVariants() { return [{ id: "v", colorId: "blue" }]; }, async listReviews() { return []; } },
  media: async ({ tenantId }) => { assert.equal(tenantId, scope.tenantId); return [{ id: "1", url: "https://example.com/one.jpg" }, { id: "2", colorOptionId: "blue" }, { id: "3", variantId: "hidden" }, { id: "4", colorOptionId: "red" }]; },
  customFields: async () => [{ label: "Material", value: "Cotton" }, { label: "Supplier cost", value: "SECRET" }, { label: "Rating", value: "4.9" }] });
  const result = await service.detail({}, "shirt");
  assert.deepEqual(result.images.map((item) => item.id), ["1", "2"]);
  assert.deepEqual(result.specifications, { Material: "Cotton" });
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});
test("catalog DAO parameterizes user input and uses store/tenant publication guards", async () => {
  const statements = [];
  const connection = { async query(sql, params) { statements.push({ sql, params }); return sql.includes("SELECT COUNT(*) AS total FROM catalog") ? [[{ total: 0 }]] : [[]]; } };
  const result = await listProducts({ scope, filters: { page: 1, pageSize: 10, search: "' OR 1=1 --", sort: "featured" }, connection });
  assert.equal(result.total, 0);
  for (const { sql, params } of statements) {
    assert.ok(sql.includes("p.publication_status = 'PUBLISHED'"));
    assert.ok(sql.includes("p.approval_status = 'APPROVED'"));
    assert.ok(sql.includes("so.tenant_id = ? AND so.store_id = ?"));
    assert.ok(sql.includes("invalid_bundles"));
    assert.ok(!sql.includes("' OR 1=1 --"));
    assert.ok(params.includes("%' OR 1=1 --%"));
  }
});
