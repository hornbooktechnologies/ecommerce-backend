import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const returnId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const orderItemId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) });
  next();
}

function allow() { return (_req, _res, next) => next(); }

function service(overrides = {}) {
  return {
    async listReturnOptions() { return { items: [], warehouses: [] }; },
    async listReturns(_tenantId, filters) { return { items: [], total: 0, page: filters.page,
      pageSize: filters.pageSize, totalPages: 1, summary: {} }; },
    async getReturn() { return { request: { id: returnId }, items: [], exchanges: [], refunds: [] }; },
    async createReturn() { return { request: { id: returnId }, items: [], exchanges: [], refunds: [] }; },
    async approveReturn() { return { request: { id: returnId, status: "APPROVED" } }; },
    async rejectReturn() { return { request: { id: returnId, status: "REJECTED" } }; },
    async receiveReturn() { return { request: { id: returnId, status: "RECEIVED" } }; },
    async inspectReturn() { return { request: { id: returnId, status: "INSPECTED" } }; },
    async completeReturn() { return { request: { id: returnId, status: "COMPLETED" } }; },
    async createExchange() { return { request: { id: returnId }, exchanges: [{ status: "PENDING" }] }; },
    async completeExchange() { return { request: { id: returnId, status: "COMPLETED" } }; },
    ...overrides
  };
}

function app(returnsService = service()) {
  return createApp({ returnsService, tenantAccessResolver: resolveTenant,
    tenantPermissionAuthorization: allow });
}

test("return routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/returns");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("return directory normalizes filters and pagination", async () => {
  let received;
  const response = await request(app(service({
    async listReturns(receivedTenantId, filters) {
      received = { receivedTenantId, filters };
      return { items: [], total: 0, page: filters.page, pageSize: filters.pageSize, totalPages: 1, summary: {} };
    }
  }))).get("/api/admin/v1/returns?status=requested&type=exchange&page=2&pageSize=10")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual({ receivedTenantId: received.receivedTenantId, filters: { ...received.filters } }, {
    receivedTenantId: tenantId,
    filters: { search: "", status: "REQUESTED", type: "EXCHANGE", page: 2, pageSize: 10 } });
});

test("return creation normalizes reason, type, and quantity", async () => {
  let received;
  const response = await request(app(service({
    async createReturn(receivedTenantId, input) {
      received = { receivedTenantId, input };
      return { request: { id: returnId }, items: [], exchanges: [], refunds: [] };
    }
  }))).post("/api/admin/v1/returns").set("authorization", `Bearer ${token}`)
    .send({ orderItemId, returnType: "exchange", quantity: "1", reasonCode: "size_fit" });
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.returnType, "EXCHANGE");
  assert.equal(received.input.reasonCode, "SIZE_FIT");
  assert.equal(received.input.quantity, 1);
});

test("return rejection requires an operator note", async () => {
  const response = await request(app()).post(`/api/admin/v1/returns/${returnId}/reject`)
    .set("authorization", `Bearer ${token}`).send({ notes: "" });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("inspection requires condition and disposition", async () => {
  let received;
  const response = await request(app(service({
    async inspectReturn(receivedTenantId, receivedReturnId, input) {
      received = { receivedTenantId, receivedReturnId, input };
      return { request: { id: receivedReturnId, status: "INSPECTED" } };
    }
  }))).post(`/api/admin/v1/returns/${returnId}/inspect`)
    .set("authorization", `Bearer ${token}`)
    .send({ itemCondition: "open_box", disposition: "quarantine", notes: "Seal opened" });
  assert.equal(response.status, 200);
  assert.deepEqual(received, { receivedTenantId: tenantId, receivedReturnId: returnId,
    input: { itemCondition: "OPEN_BOX", disposition: "QUARANTINE", notes: "Seal opened" } });
});
