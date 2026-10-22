import assert from "node:assert/strict";
import test from "node:test";
import { createAccessControlService } from "../src/modules/access-control/access-control.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const actorUserId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const roleId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b99";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79baa";
const context = { actorUserId, requestId: "request-1", ipAddress: "127.0.0.1", userAgent: "test" };

test("custom role creation validates permissions and writes audit records", async () => {
  const calls = { roles: [], permissions: [], audits: [], events: [] };
  const dao = {
    async permissionsExist({ permissionKeys }) { return permissionKeys; },
    async findRoleByKey() { return null; },
    async insertRole({ role }) { calls.roles.push(role); },
    async replaceRolePermissions(input) { calls.permissions.push(input); },
    async insertAudit({ audit }) { calls.audits.push(audit); },
    async insertOutbox({ event }) { calls.events.push(event); },
    async listRoles() {
      return [{ id: calls.roles[0].id, name: calls.roles[0].name, permissions: calls.permissions[0].permissionKeys }];
    }
  };
  const service = createAccessControlService({ dao, transaction: async (_id, operation) => operation({}) });
  const role = await service.createRole(tenantId, {
    name: "Store Supervisor", level: "TENANT", permissionKeys: ["dashboard.read", "order.read"]
  }, context);

  assert.equal(role.name, "Store Supervisor");
  assert.equal(calls.roles[0].key, "store_supervisor");
  assert.equal(calls.audits[0].action, "settings.role.created");
  assert.equal(calls.events[0].aggregateType, "ROLE");
});

test("role assignment rejects a role from another tenant", async () => {
  const dao = {
    async findMembership() { return { membershipType: "STAFF", status: "ACTIVE" }; },
    async rolesBelongToTenant() { return []; }
  };
  const service = createAccessControlService({ dao, transaction: async (_id, operation) => operation({}) });
  await assert.rejects(
    () => service.setRoleAssignments(tenantId, userId, [
      { roleId, scopeType: "TENANT", scopeId: null }
    ], context),
    (caught) => caught.code === "INVALID_ROLE_SCOPE" && caught.status === 422
  );
});

test("tenant owner cannot be suspended", async () => {
  const dao = {
    async findMembership() { return { membershipType: "OWNER", status: "ACTIVE" }; }
  };
  const service = createAccessControlService({ dao, transaction: async (_id, operation) => operation({}) });
  await assert.rejects(
    () => service.suspendUser(tenantId, userId, context),
    (caught) => caught.code === "OWNER_SUSPENSION_NOT_ALLOWED" && caught.status === 409
  );
});
