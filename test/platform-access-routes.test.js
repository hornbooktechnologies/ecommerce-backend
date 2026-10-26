import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const roleId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b78";
const accessToken = createAccessToken({ userId,
  sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b99" });
const allow = (_req, _res, next) => next();

function service(overrides = {}) {
  return {
    async listUsers(input) { return { items: [], total: 0, summary: {}, page: input.page,
      pageSize: input.pageSize, totalPages: 1 }; },
    async inviteUser(input) { return { id: userId, email: input.email, status: "INVITED" }; },
    async activateUser(id) { return { id, status: "ACTIVE" }; },
    async suspendUser(id) { return { id, status: "SUSPENDED" }; },
    async setRoleAssignments(id, roleIds) { return { userId: id, roleIds }; },
    async listRoles() { return []; },
    async getRole(id) { return { id, name: "Support" }; },
    async createRole(input) { return { id: roleId, ...input }; },
    async updateRole(id, input) { return { id, ...input }; },
    async deleteRole() {},
    async listPermissions() { return []; },
    ...overrides
  };
}

function app(overrides) {
  return createApp({ platformAccessService: service(overrides), platformAccessAuthorization: allow });
}

test("platform access routes require authentication", async () => {
  const response = await request(app()).get("/api/platform/v1/access/users");
  assert.equal(response.status, 401);
});

test("platform user directory normalizes pagination and filters", async () => {
  let received;
  const response = await request(app({ async listUsers(input) { received = input;
    return { items: [], total: 0, summary: {}, page: input.page, pageSize: input.pageSize, totalPages: 1 }; } }))
    .get("/api/platform/v1/access/users?status=active&page=2&pageSize=10&search=Admin")
    .set("authorization", `Bearer ${accessToken}`);
  assert.equal(response.status, 200);
  assert.deepEqual({ ...received }, { status: "ACTIVE", page: 2, pageSize: 10, search: "Admin" });
});

test("platform invitations require a strong password and at least one role", async () => {
  const response = await request(app()).post("/api/platform/v1/access/users/invitations")
    .set("authorization", `Bearer ${accessToken}`)
    .send({ firstName: "Asha", email: "asha@example.com", temporaryPassword: "short", roleIds: [] });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("platform roles accept only platform permission keys", async () => {
  const response = await request(app()).post("/api/platform/v1/access/roles")
    .set("authorization", `Bearer ${accessToken}`)
    .send({ name: "Operator", permissionKeys: ["order.read"] });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("platform invitation and role assignment use validated payloads", async () => {
  let invitation;
  let assignment;
  const response = await request(app({
    async inviteUser(input) { invitation = input; return { id: userId, status: "INVITED" }; },
    async setRoleAssignments(id, roleIds) { assignment = { id, roleIds }; return assignment; }
  })).post("/api/platform/v1/access/users/invitations")
    .set("authorization", `Bearer ${accessToken}`)
    .send({ firstName: "Asha", lastName: "Rao", email: "ASHA@example.com",
      temporaryPassword: "temporary-password-2026", roleIds: [roleId] });
  assert.equal(response.status, 201);
  assert.equal(invitation.email, "asha@example.com");

  const assigned = await request(app({ async setRoleAssignments(id, roleIds) {
    assignment = { id, roleIds }; return assignment; } }))
    .put(`/api/platform/v1/access/users/${userId}/role-assignments`)
    .set("authorization", `Bearer ${accessToken}`).send({ roleIds: [roleId] });
  assert.equal(assigned.status, 200);
  assert.deepEqual(assignment.roleIds, [roleId]);
});
