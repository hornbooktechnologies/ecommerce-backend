import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";
import { parseCsv, stringifyCsv } from "../src/modules/bulk-operations/csv.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const jobId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });
function resolveTenant(req, _res, next) { req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) }); next(); }
function allow() { return (_req, _res, next) => next(); }
function service(overrides = {}) { return {
  async listJobs() { return { items: [], total: 0, page: 1, pageSize: 20, totalPages: 1 }; },
  async getJob() { return { id: jobId, type: "PRODUCT", status: "READY", rows: [] }; },
  async validateImport(_tenantId, type, input) { return { id: jobId, type, fileName: input.fileName, status: "READY" }; },
  async commitImport(_tenantId, type) { return { id: jobId, type, status: "COMPLETED" }; },
  template(type) { return { filename: `${type}.csv`, csv: "code\r\nexample" }; },
  async exportFile(type) { return { filename: `${type}.csv`, csv: "code\r\nexample" }; },
  async errorReport() { return { filename: "errors.csv", csv: "row,message" }; },
  async bulkTransition(_tenantId, productIds, action) { return { action, completed: productIds.length, failed: 0, results: [] }; },
  ...overrides
}; }
function app(bulkOperationsService = service()) { return createApp({ bulkOperationsService,
  tenantAccessResolver: resolveTenant, tenantPermissionAuthorization: allow }); }

test("CSV parser preserves quoted commas, new lines, and escaped quotes", () => {
  const csv = stringifyCsv(["sku", "description"], [{ sku: "A-1", description: "Large, \"safe\" bottle\nBlue" }]);
  assert.deepEqual(parseCsv(csv).rows[0].data, { sku: "A-1", description: "Large, \"safe\" bottle\nBlue" });
});

test("product CSV validation is tenant scoped and creates a staged job", async () => {
  let received;
  const response = await request(app(service({ async validateImport(receivedTenantId, type, input) {
    received = { receivedTenantId, type, input }; return { id: jobId, type, status: "READY" };
  } }))).post("/api/admin/v1/bulk/products/validate").set("authorization", `Bearer ${token}`)
    .send({ fileName: "products.csv", csv: "product_code,name\r\nA-1,Product" });
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.type, "PRODUCT");
  assert.equal(response.body.data.status, "READY");
});

test("bulk publication accepts a unique product selection", async () => {
  const response = await request(app()).post("/api/admin/v1/bulk/products/publish")
    .set("authorization", `Bearer ${token}`).send({ productIds: [userId] });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.action, "publish");
  assert.equal(response.body.data.completed, 1);
});

test("bulk import endpoints reject oversized or non-CSV input", async () => {
  const response = await request(app()).post("/api/admin/v1/bulk/pricing/validate")
    .set("authorization", `Bearer ${token}`).send({ fileName: "pricing.txt", csv: "offer_id" });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});
