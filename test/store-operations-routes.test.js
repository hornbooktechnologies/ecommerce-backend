import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const storeId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const zoneId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const token = createAccessToken({ userId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77",
  sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) });
  next();
}
function allow() { return (_req, _res, next) => next(); }
function service(overrides = {}) {
  return {
    async listStores(_tenantId, filters) { return { items: [], total: 0, page: filters.page,
      pageSize: filters.pageSize, totalPages: 1, summary: {} }; },
    async getStore() { return { store: { id: storeId }, zones: [], templates: [], instances: [], warehouses: [] }; },
    async createStore(_tenantId, input) { return { store: { id: storeId, ...input } }; },
    async updateStore(_tenantId, _storeId, input) { return { store: { id: storeId, ...input } }; },
    async createZone(_tenantId, _storeId, input) { return { id: zoneId, ...input }; },
    async updateZone(_tenantId, _storeId, _zoneId, input) { return { id: zoneId, ...input }; },
    async createTemplate(_tenantId, _storeId, input) { return { id: zoneId, ...input }; },
    async updateTemplate(_tenantId, _storeId, _templateId, input) { return { id: zoneId, ...input }; },
    async generateSlots(_tenantId, _storeId, input) { return { created: input.days, instances: [] }; },
    async assignWarehouses() { return { warehouses: [] }; },
    ...overrides
  };
}
function app(storeOperationsService = service()) {
  return createApp({ storeOperationsService, tenantAccessResolver: resolveTenant,
    tenantPermissionAuthorization: allow });
}

test("store operations routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/stores");
  assert.equal(response.status, 401);
});

test("store creation normalizes code and India address", async () => {
  let received;
  const response = await request(app(service({ async createStore(receivedTenantId, input) {
    received = { receivedTenantId, input }; return { store: { id: storeId, ...input } };
  } }))).post("/api/admin/v1/stores").set("authorization", `Bearer ${token}`).send({
    code: "blr-east", name: "Bengaluru East", line1: "12 Main Road", city: "Bengaluru",
    stateCode: "ka", stateName: "Karnataka", postalCode: "560038"
  });
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.code, "BLR-EAST");
  assert.equal(received.input.stateCode, "KA");
  assert.equal(received.input.substitutionPolicy, "CONTACT_ME");
});

test("delivery zone validates and forwards PIN coverage", async () => {
  let received;
  const response = await request(app(service({ async createZone(_tenantId, _storeId, input) {
    received = input; return { id: zoneId, ...input };
  } }))).post(`/api/admin/v1/stores/${storeId}/zones`).set("authorization", `Bearer ${token}`).send({
    name: "Central Bengaluru", postalCodes: ["560001", "560025"], deliveryFee: "39"
  });
  assert.equal(response.status, 201);
  assert.equal(received.deliveryFee, 39);
  assert.deepEqual(received.postalCodes, ["560001", "560025"]);
});

test("weekly slot rejects an end time before its start time", async () => {
  const response = await request(app()).post(`/api/admin/v1/stores/${storeId}/slots`)
    .set("authorization", `Bearer ${token}`).send({ zoneId, name: "Invalid window", dayOfWeek: 1,
      startTime: "18:00", endTime: "08:00", orderCapacity: 20 });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("slot generation enforces a safe planning horizon", async () => {
  const response = await request(app()).post(`/api/admin/v1/stores/${storeId}/slots/generate`)
    .set("authorization", `Bearer ${token}`).send({ days: 90 });
  assert.equal(response.status, 422);
});
