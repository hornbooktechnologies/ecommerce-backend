import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const roleId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b99";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) });
  next();
}

function allow() {
  return (_req, _res, next) => next();
}

function service(overrides = {}) {
  return {
    async listUsers(_tenantId, input) {
      return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 1 };
    },
    async listRoles() { return []; },
    async listPermissions() { return []; },
    async getRole() { return { id: roleId, name: "Manager" }; },
    async createRole(_tenantId, input) { return { id: roleId, ...input }; },
    async updateRole(_tenantId, id, input) { return { id, ...input }; },
    async deleteRole() {},
    async inviteUser(_tenantId, input) { return { id: userId, email: input.email, status: "INVITED" }; },
    async activateUser() { return { id: userId, status: "ACTIVE" }; },
    async suspendUser() { return { id: userId, status: "SUSPENDED" }; },
    async setRoleAssignments(_tenantId, id, assignments) { return { userId: id, assignments }; },
    ...overrides
  };
}

function app(accessControlService = service()) {
  return createApp({ accessControlService, tenantAccessResolver: resolveTenant, tenantPermissionAuthorization: allow });
}

test("tenant access routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/users");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("user directory normalizes filters and remains tenant scoped", async () => {
  let receivedTenant;
  let receivedFilters;
  const response = await request(app(service({
    async listUsers(id, filters) {
      receivedTenant = id;
      receivedFilters = filters;
      return { items: [], total: 0, page: filters.page, pageSize: filters.pageSize, totalPages: 1 };
    }
  })))
    .get("/api/admin/v1/users?status=active&page=2&pageSize=10")
    .set("authorization", `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.equal(receivedTenant, tenantId);
  assert.deepEqual({ ...receivedFilters }, { search: "", status: "ACTIVE", page: 2, pageSize: 10 });
});

test("role creation validates permission input", async () => {
  const response = await request(app())
    .post("/api/admin/v1/roles")
    .set("authorization", `Bearer ${token}`)
    .send({ name: "Empty role", permissionKeys: [] });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("tenant invitation creates an inactive membership", async () => {
  const response = await request(app())
    .post("/api/admin/v1/users/invitations")
    .set("authorization", `Bearer ${token}`)
    .send({
      email: "member@example.com", firstName: "Kavya", lastName: "Shah",
      temporaryPassword: "temporary-password-2026",
      assignments: [{ roleId, scopeType: "TENANT", scopeId: null }]
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.user.status, "INVITED");
});
