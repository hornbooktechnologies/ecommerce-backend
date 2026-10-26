import assert from "node:assert/strict";
import test from "node:test";
import { createPlatformAccessService } from "../src/modules/platform-access/platform-access.service.js";

const actorId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const memberId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b78";
const roleId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b79";
const context = { actorUserId: actorId, requestId: "request-1", ipAddress: "127.0.0.1" };
const transaction = (_tenantId, operation) => operation({});

test("platform custom role creation validates permissions and writes audit records", async () => {
  const calls = { audits: [], events: [] };
  const dao = {
    async permissionsExist({ permissionKeys }) { return permissionKeys; },
    async findRoleByKey() { return null; },
    async insertRole({ role }) { calls.role = role; },
    async replaceRolePermissions({ permissionKeys }) { calls.permissions = permissionKeys; },
    async insertAudit({ audit }) { calls.audits.push(audit); },
    async insertOutbox({ event }) { calls.events.push(event); },
    async listRoles() { return [{ id: calls.role.id, name: calls.role.name,
      permissions: calls.permissions, isSystem: false }]; }
  };
  const service = createPlatformAccessService({ dao, transaction });
  const role = await service.createRole({ name: "Tenant reviewer",
    permissionKeys: ["platform.tenant.read"] }, context);
  assert.equal(role.name, "Tenant reviewer");
  assert.equal(calls.audits[0].action, "platform.role.created");
  assert.equal(calls.audits[0].tenantId, null);
  assert.equal(calls.events.length, 1);
});

test("a platform operator cannot suspend their own access", async () => {
  const service = createPlatformAccessService({ dao: {}, transaction });
  await assert.rejects(() => service.suspendUser(actorId, context),
    (error) => error.code === "SELF_SUSPENSION_NOT_ALLOWED" && error.status === 409);
});

test("the final active super administrator cannot be suspended", async () => {
  const dao = {
    async findMembership() { return { userId: memberId, status: "ACTIVE" }; },
    async userHasRole() { return true; },
    async countActiveSuperAdmins() { return 1; }
  };
  const service = createPlatformAccessService({ dao, transaction });
  await assert.rejects(() => service.suspendUser(memberId, context),
    (error) => error.code === "LAST_SUPER_ADMIN_PROTECTED" && error.status === 409);
});

test("role assignments are restricted to platform roles", async () => {
  const calls = [];
  const dao = {
    async findMembership() { return { userId: memberId, status: "ACTIVE" }; },
    async userHasRole() { return false; },
    async rolesBelongToPlatform() { return []; },
    async revokeRoleAssignments() { calls.push("revoke"); }
  };
  const service = createPlatformAccessService({ dao, transaction });
  await assert.rejects(() => service.setRoleAssignments(memberId, [roleId], context),
    (error) => error.code === "INVALID_PLATFORM_ROLE" && error.status === 422);
  assert.deepEqual(calls, []);
});
