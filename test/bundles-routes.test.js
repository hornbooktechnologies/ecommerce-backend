import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";
const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88"; const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const bundleId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66"; const componentId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const rowId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b44"; const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });
function resolveTenant(req, _res, next) { req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) }); next(); }
function allow() { return (_req, _res, next) => next(); }
function service(overrides = {}) { return { async listVariants(_tenantId, input) { return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 1 }; },
  async listBundles(_tenantId, input) { return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 1, summary: {} }; },
  async createComponent(_tenantId, receivedBundleId, input) { return { id: rowId, bundleVariantId: receivedBundleId, ...input }; },
  async updateComponent(_tenantId, _bundleId, receivedId, input) { return { id: receivedId, ...input }; }, async deleteComponent() {}, ...overrides }; }
function app(bundlesService = service()) { return createApp({ bundlesService, tenantAccessResolver: resolveTenant, tenantPermissionAuthorization: allow }); }

test("bundle routes require authentication", async () => { const response = await request(app()).get("/api/admin/v1/catalog/bundles"); assert.equal(response.status, 401); });
test("bundle directory normalizes search and pagination", async () => { let received; const response = await request(app(service({ async listBundles(receivedTenantId, input) { received = { receivedTenantId, input }; return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 1, summary: {} }; } })))
  .get("/api/admin/v1/catalog/bundles?search=starter&page=2&pageSize=10").set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200); assert.equal(received.receivedTenantId, tenantId); assert.deepEqual({ ...received.input }, { search: "starter", page: 2, pageSize: 10 }); });
test("bundle component mutations normalize quantities and flags", async () => {
  const created = await request(app()).post(`/api/admin/v1/catalog/bundles/${bundleId}/components`).set("authorization", `Bearer ${token}`)
    .send({ componentVariantId: componentId, quantity: "2.5", isOptional: true });
  assert.equal(created.status, 201); assert.equal(created.body.data.component.quantity, 2.5);
  const updated = await request(app()).patch(`/api/admin/v1/catalog/bundles/${bundleId}/components/${rowId}`).set("authorization", `Bearer ${token}`)
    .send({ quantity: 3, isOptional: false, sortOrder: 1 });
  assert.equal(updated.status, 200); assert.equal(updated.body.data.component.sortOrder, 1);
  const removed = await request(app()).delete(`/api/admin/v1/catalog/bundles/${bundleId}/components/${rowId}`).set("authorization", `Bearer ${token}`);
  assert.equal(removed.status, 204);
});
test("bundle component quantity must be positive", async () => { const response = await request(app()).post(`/api/admin/v1/catalog/bundles/${bundleId}/components`)
  .set("authorization", `Bearer ${token}`).send({ componentVariantId: componentId, quantity: 0 }); assert.equal(response.status, 422); });
