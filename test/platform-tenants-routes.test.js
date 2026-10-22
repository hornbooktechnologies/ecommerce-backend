import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const accessToken = createAccessToken({
  userId,
  sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b99"
});

function allowPlatform(_req, _res, next) {
  next();
}

function tenantService(overrides = {}) {
  return {
    async listTenants(input) {
      return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 1, summary: {} };
    },
    async createTenant(input) {
      return { id: tenantId, code: input.code, status: "PENDING" };
    },
    async getTenant(id) {
      return { id, code: "NORTHSTAR", status: "PENDING" };
    },
    async updateTenant(id, input) {
      return { id, ...input };
    },
    async activateTenant(id, reason) {
      return { id, status: "ACTIVE", reason };
    },
    async suspendTenant(id, reason) {
      return { id, status: "SUSPENDED", reason };
    },
    async restoreTenant(id, reason) {
      return { id, status: "ACTIVE", reason };
    },
    ...overrides
  };
}

function app(service = tenantService()) {
  return createApp({
    platformTenantService: service,
    platformAuthorization: allowPlatform
  });
}

test("platform tenant routes require authentication", async () => {
  const response = await request(app()).get("/api/platform/v1/tenants");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("GET /platform tenants validates and normalizes directory filters", async () => {
  let received;
  const response = await request(app(tenantService({
    async listTenants(input) {
      received = input;
      return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 1, summary: {} };
    }
  })))
    .get("/api/platform/v1/tenants?status=active&page=2&pageSize=10&search=North")
    .set("authorization", `Bearer ${accessToken}`);

  assert.equal(response.status, 200);
  assert.deepEqual({ ...received }, { status: "ACTIVE", page: 2, pageSize: 10, search: "North" });
});

test("POST /platform tenants returns field-level validation errors", async () => {
  const response = await request(app())
    .post("/api/platform/v1/tenants")
    .set("authorization", `Bearer ${accessToken}`)
    .send({ code: "!", legalName: "", displayName: "" });

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
  assert.ok(response.body.error.details.some((detail) => detail.field === "owner"));
  assert.ok(response.body.error.details.some((detail) => detail.field === "defaultStore"));
  assert.ok(response.body.error.details.some((detail) => detail.field === "catalogVerticals"));
});

test("POST /platform tenants creates the default tenant structure", async () => {
  const response = await request(app())
    .post("/api/platform/v1/tenants")
    .set("authorization", `Bearer ${accessToken}`)
    .send({
      code: "northstar",
      legalName: "Northstar Retail Private Limited",
      displayName: "Northstar Retail",
      catalogVerticals: ["GENERAL", "GROCERY"],
      owner: {
        email: "owner@northstar.com",
        firstName: "Asha",
        lastName: "Rao",
        temporaryPassword: "temporary-password-2026"
      },
      defaultStore: {
        code: "main",
        name: "Northstar Main Store",
        supportEmail: "help@northstar.com"
      }
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.data.tenant.code, "NORTHSTAR");
  assert.equal(response.body.data.tenant.status, "PENDING");
});

test("tenant lifecycle actions require an audit reason", async () => {
  const missingReason = await request(app())
    .post(`/api/platform/v1/tenants/${tenantId}/activate`)
    .set("authorization", `Bearer ${accessToken}`)
    .send({});
  assert.equal(missingReason.status, 422);

  const activated = await request(app())
    .post(`/api/platform/v1/tenants/${tenantId}/activate`)
    .set("authorization", `Bearer ${accessToken}`)
    .send({ reason: "Business verification completed" });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.data.tenant.status, "ACTIVE");
});
