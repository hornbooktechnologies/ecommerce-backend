import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const customerId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) });
  next();
}

function allow() { return (_req, _res, next) => next(); }

function service(overrides = {}) {
  return {
    async listCustomers(_tenantId, filters) {
      return { items: [], total: 0, page: filters.page, pageSize: filters.pageSize,
        totalPages: 1, summary: {} };
    },
    async getCustomer(_tenantId, id) { return { customer: { id }, addresses: [], orders: [], returns: [], warranties: [] }; },
    async updateCustomer(_tenantId, id, input) {
      return { customer: { id, ...input }, addresses: [], orders: [], returns: [], warranties: [] };
    },
    ...overrides
  };
}

function app(customersService = service()) {
  return createApp({ customersService, tenantAccessResolver: resolveTenant,
    tenantPermissionAuthorization: allow });
}

test("customer routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/customers");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("customer directory normalizes tenant-scoped filters", async () => {
  let received;
  const response = await request(app(service({
    async listCustomers(receivedTenantId, filters) {
      received = { receivedTenantId, filters };
      return { items: [], total: 0, page: filters.page, pageSize: filters.pageSize,
        totalPages: 1, summary: {} };
    }
  }))).get("/api/admin/v1/customers?search=Asha&status=active&type=business&page=2&pageSize=10")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual({ ...received, filters: { ...received.filters } }, { receivedTenantId: tenantId,
    filters: { search: "Asha", status: "ACTIVE", type: "BUSINESS", page: 2, pageSize: 10 } });
});

test("customer details remain tenant scoped", async () => {
  let received;
  const response = await request(app(service({
    async getCustomer(receivedTenantId, receivedCustomerId) {
      received = { receivedTenantId, receivedCustomerId };
      return { customer: { id: receivedCustomerId }, addresses: [], orders: [], returns: [], warranties: [] };
    }
  }))).get(`/api/admin/v1/customers/${customerId}`).set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual(received, { receivedTenantId: tenantId, receivedCustomerId: customerId });
});

test("customer updates normalize profile data", async () => {
  let received;
  const response = await request(app(service({
    async updateCustomer(receivedTenantId, receivedCustomerId, input) {
      received = { receivedTenantId, receivedCustomerId, input };
      return { customer: { id: receivedCustomerId, ...input }, addresses: [], orders: [], returns: [], warranties: [] };
    }
  }))).patch(`/api/admin/v1/customers/${customerId}`).set("authorization", `Bearer ${token}`)
    .send({ firstName: "  Asha ", lastName: " Rao ", email: "ASHA@EXAMPLE.IN",
      phone: "", type: "business", companyName: " Asha Retail ", gstin: "29ABCDE1234F1Z5",
      status: "active", notes: " Priority account " });
  assert.equal(response.status, 200);
  assert.deepEqual(received, { receivedTenantId: tenantId, receivedCustomerId: customerId,
    input: { firstName: "Asha", lastName: "Rao", email: "asha@example.in", phone: "",
      type: "BUSINESS", companyName: "Asha Retail", gstin: "29ABCDE1234F1Z5",
      status: "ACTIVE", notes: "Priority account" } });
});

test("customer updates require contact information", async () => {
  const response = await request(app()).patch(`/api/admin/v1/customers/${customerId}`)
    .set("authorization", `Bearer ${token}`).send({ firstName: "Asha", lastName: "",
      email: "", phone: "", type: "INDIVIDUAL", status: "ACTIVE" });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});
