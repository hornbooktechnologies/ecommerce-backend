import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const warrantyId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const claimId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) });
  next();
}

function allow() { return (_req, _res, next) => next(); }

function service(overrides = {}) {
  return {
    async listWarrantyOptions() { return { assignees: [] }; },
    async listWarranties(_tenantId, filters) { return { items: [], total: 0, page: filters.page,
      pageSize: filters.pageSize, totalPages: 1, summary: {} }; },
    async getWarranty() { return { warranty: { id: warrantyId }, claims: [] }; },
    async listClaims(_tenantId, filters) { return { items: [], total: 0, page: filters.page,
      pageSize: filters.pageSize, totalPages: 1, summary: {} }; },
    async getClaim() { return { claim: { id: claimId }, events: [] }; },
    async createClaim() { return { claim: { id: claimId, status: "OPEN" }, events: [] }; },
    async assignClaim() { return { claim: { id: claimId, status: "ASSIGNED" }, events: [] }; },
    async diagnoseClaim() { return { claim: { id: claimId, status: "DIAGNOSED" }, events: [] }; },
    async resolveClaim() { return { claim: { id: claimId, status: "RESOLVED" }, events: [] }; },
    async closeClaim() { return { claim: { id: claimId, status: "CLOSED" }, events: [] }; },
    ...overrides
  };
}

function app(warrantiesService = service()) {
  return createApp({ warrantiesService, tenantAccessResolver: resolveTenant,
    tenantPermissionAuthorization: allow });
}

test("warranty routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/warranties");
  assert.equal(response.status, 401);
});

test("warranty directory normalizes status and pagination", async () => {
  let received;
  const response = await request(app(service({
    async listWarranties(receivedTenantId, filters) {
      received = { receivedTenantId, filters };
      return { items: [], total: 0, page: filters.page, pageSize: filters.pageSize, totalPages: 1, summary: {} };
    }
  }))).get("/api/admin/v1/warranties?status=active&page=2&pageSize=10")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual({ ...received.filters }, { search: "", status: "ACTIVE", page: 2, pageSize: 10 });
  assert.equal(received.receivedTenantId, tenantId);
});

test("opening a warranty claim forwards tenant-scoped input", async () => {
  let received;
  const response = await request(app(service({
    async createClaim(receivedTenantId, input) {
      received = { receivedTenantId, input };
      return { claim: { id: claimId, status: "OPEN" }, events: [] };
    }
  }))).post("/api/admin/v1/warranty-claims")
    .set("authorization", `Bearer ${token}`)
    .send({ warrantyRegistrationId: warrantyId, issueDescription: "Display flickers after warm-up" });
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.warrantyRegistrationId, warrantyId);
});

test("claim resolution normalizes the resolution type", async () => {
  let received;
  const response = await request(app(service({
    async resolveClaim(receivedTenantId, receivedClaimId, input) {
      received = { receivedTenantId, receivedClaimId, input };
      return { claim: { id: receivedClaimId, status: "RESOLVED" }, events: [] };
    }
  }))).post(`/api/admin/v1/warranty-claims/${claimId}/resolve`)
    .set("authorization", `Bearer ${token}`)
    .send({ resolutionType: "repair", resolutionNotes: "Replaced the display controller board" });
  assert.equal(response.status, 200);
  assert.equal(received.input.resolutionType, "REPAIR");
  assert.equal(received.receivedClaimId, claimId);
});

test("claim diagnosis requires useful notes", async () => {
  const response = await request(app()).post(`/api/admin/v1/warranty-claims/${claimId}/diagnose`)
    .set("authorization", `Bearer ${token}`).send({ diagnosisNotes: "bad" });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});
