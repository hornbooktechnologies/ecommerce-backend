import assert from "node:assert/strict";
import test from "node:test";
import { createPlatformTenantService } from "../src/modules/platform-tenants/platform-tenants.service.js";

const actorUserId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";

function creationDao(calls) {
  return {
    async findTenantByCode() { return null; },
    async findUserByEmail() { return null; },
    async insertUser(input) { calls.users.push(input.user); },
    async insertTenant(input) { calls.tenants.push(input.tenant); },
    async insertTenantProductVerticals(input) { calls.catalogVerticals.push(...input.verticals); },
    async insertStore(input) { calls.stores.push(input.store); },
    async insertSalesChannel(input) { calls.channels.push(input.channel); },
    async insertMerchant(input) { calls.merchants.push(input.merchant); },
    async linkStoreMerchant(input) { calls.links.push(input); },
    async insertRole(input) { calls.roles.push(input.role); },
    async insertRolePermissions(input) { calls.rolePermissions.push(input); },
    async insertMembership(input) { calls.memberships.push(input.membership); },
    async insertRoleAssignment(input) { calls.assignments.push(input.assignment); },
    async insertNumberSequence(input) { calls.sequences.push(input.sequence); },
    async insertAuditLog(input) { calls.audits.push(input.audit); },
    async insertOutboxEvent(input) { calls.events.push(input.event); },
    async findTenantById({ tenantId }) {
      return { id: tenantId, code: "NORTHSTAR", displayName: "Northstar", status: "PENDING" };
    },
    async listTenantStores() { return calls.stores; },
    async listTenantMerchants() { return calls.merchants; },
    async findTenantOwner() { return calls.users[0]; },
    async listTenantAudit() { return calls.audits; },
    async listTenantProductVerticals() { return calls.catalogVerticals; }
  };
}

test("tenant provisioning creates all required records inside one transaction", async () => {
  const calls = {
    users: [], tenants: [], stores: [], channels: [], merchants: [], links: [], roles: [],
    memberships: [], assignments: [], sequences: [], audits: [], events: [], rolePermissions: [],
    catalogVerticals: []
  };
  let transactionCount = 0;
  const service = createPlatformTenantService({
    tenantDao: creationDao(calls),
    passwordHasher: async () => "hashed-password",
    transaction: async (_tenantId, operation) => {
      transactionCount += 1;
      return operation({ transaction: true });
    }
  });

  const tenant = await service.createTenant({
    code: "NORTHSTAR",
    legalName: "Northstar Retail Private Limited",
    displayName: "Northstar Retail",
    defaultCurrency: "INR",
    defaultLanguage: "en-IN",
    timezone: "Asia/Kolkata",
    catalogVerticals: ["GROCERY", "ELECTRONICS"],
    owner: {
      email: "owner@northstar.example",
      firstName: "Asha",
      lastName: "Rao",
      temporaryPassword: "temporary-password-2026"
    },
    defaultStore: { code: "MAIN", name: "Main Store", supportEmail: null, supportPhone: null }
  }, {
    actorUserId,
    requestId: "request-1",
    ipAddress: "127.0.0.1",
    userAgent: "test"
  });

  assert.equal(transactionCount, 1);
  assert.equal(tenant.status, "PENDING");
  assert.equal(calls.stores.length, 1);
  assert.equal(calls.channels.length, 1);
  assert.equal(calls.merchants[0].code, "FIRST_PARTY");
  assert.deepEqual(calls.catalogVerticals, ["GROCERY", "ELECTRONICS"]);
  assert.equal(calls.roles.length, 11);
  assert.equal(calls.rolePermissions.length, 11);
  assert.equal(calls.rolePermissions.some((item) => Array.isArray(item.permissionKeys)
    && item.permissionKeys.includes("catalog.offer.manage")), true);
  assert.equal(calls.assignments.length, 1);
  assert.equal(calls.sequences.length, 8);
  assert.equal(calls.audits[0].action, "platform.tenant.created");
  assert.equal(calls.events[0].type, "tenant.created");
});

test("tenant activation rejects an invalid current state", async () => {
  const service = createPlatformTenantService({
    tenantDao: {
      async findTenantById() { return { id: "tenant", status: "ACTIVE" }; }
    },
    transaction: async (_tenantId, operation) => operation({})
  });

  await assert.rejects(
    () => service.activateTenant("018f47f2-6b6d-7c34-ae31-8f4f17b79b88", "Again", { actorUserId }),
    (error) => error.code === "INVALID_STATE_TRANSITION" && error.status === 409
  );
});

test("tenant product types in use cannot be disabled", async () => {
  const service = createPlatformTenantService({
    tenantDao: {
      async findTenantById() { return { id: tenantId, legalName: "Northstar", displayName: "Northstar", timezone: "Asia/Kolkata" }; },
      async listTenantProductVerticals() { return ["GROCERY", "CLOTHING"]; },
      async countProductsByVerticals() { return [{ vertical: "CLOTHING", productCount: 2 }]; }
    },
    transaction: async (_tenantId, operation) => operation({})
  });

  await assert.rejects(
    () => service.updateTenant(tenantId, { catalogVerticals: ["GROCERY"] }, {
      actorUserId, requestId: "request-2"
    }),
    (error) => error.code === "PRODUCT_TYPE_IN_USE" && error.status === 409
  );
});
