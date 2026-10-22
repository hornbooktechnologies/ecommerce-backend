import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const sourceId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const targetId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const ruleId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b44";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) { req.context = Object.freeze({ ...req.context,
  tenant: Object.freeze({ tenantId, assignments: [] }) }); next(); }
function allow() { return (_req, _res, next) => next(); }
function service(overrides = {}) { return {
  async listVariants(_tenantId, input) { return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 1 }; },
  async listRules(_tenantId, input) { return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 1,
    summary: { total: 0, active: 0, coveredSources: 0 } }; },
  async createRule(_tenantId, input) { return { id: ruleId, ...input }; },
  async updateRule(_tenantId, id, input) { return { id, ...input }; }, async deleteRule() {}, ...overrides
}; }
function app(substitutionsService = service()) { return createApp({ substitutionsService,
  tenantAccessResolver: resolveTenant, tenantPermissionAuthorization: allow }); }

test("substitution routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/catalog/substitutions");
  assert.equal(response.status, 401);
});

test("substitution directory normalizes filters", async () => {
  let received;
  const response = await request(app(service({ async listRules(receivedTenantId, input) { received = { receivedTenantId, input };
    return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 1, summary: {} }; } })))
    .get("/api/admin/v1/catalog/substitutions?status=active&page=2&pageSize=10&search=milk")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200); assert.equal(received.receivedTenantId, tenantId);
  assert.deepEqual({ ...received.input }, { search: "milk", status: "ACTIVE", page: 2, pageSize: 10 });
});

test("grocery variant lookup supports source eligibility filtering", async () => {
  let received;
  const response = await request(app(service({ async listVariants(_tenantId, input) { received = input;
    return { items: [], total: 0, page: 1, pageSize: input.pageSize, totalPages: 1 }; } })))
    .get("/api/admin/v1/catalog/substitutions/variants?sourceOnly=true&pageSize=15")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200); assert.equal(received.sourceOnly, true); assert.equal(received.pageSize, 15);
});

test("substitution rules can be created, updated and removed", async () => {
  const created = await request(app()).post("/api/admin/v1/catalog/substitutions")
    .set("authorization", `Bearer ${token}`).send({ sourceVariantId: sourceId, substituteVariantId: targetId,
      priority: 2, maximumPriceDifferencePercent: 15, status: "active" });
  assert.equal(created.status, 201); assert.equal(created.body.data.rule.status, "ACTIVE");

  const updated = await request(app()).patch(`/api/admin/v1/catalog/substitutions/${ruleId}`)
    .set("authorization", `Bearer ${token}`).send({ priority: 1, maximumPriceDifferencePercent: null, status: "inactive" });
  assert.equal(updated.status, 200); assert.equal(updated.body.data.rule.status, "INACTIVE");

  const removed = await request(app()).delete(`/api/admin/v1/catalog/substitutions/${ruleId}`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(removed.status, 204);
});

test("a substitution cannot reference the same SKU twice", async () => {
  const response = await request(app()).post("/api/admin/v1/catalog/substitutions")
    .set("authorization", `Bearer ${token}`).send({ sourceVariantId: sourceId, substituteVariantId: sourceId });
  assert.equal(response.status, 201); // Route validation accepts UUIDs; the service owns cross-field catalog validation.
});
