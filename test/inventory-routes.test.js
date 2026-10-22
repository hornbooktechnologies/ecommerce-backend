import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const balanceId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const warehouseId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const offerId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b44";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) });
  next();
}

function allow() { return (_req, _res, next) => next(); }

function service(overrides = {}) {
  return {
    async listOptions() { return { warehouses: [], offers: [] }; },
    async createWarehouse(_tenantId, input) { return { id: warehouseId, ...input, status: "ACTIVE" }; },
    async getBalance() { return { balance: { id: balanceId }, lots: [] }; },
    async listTraceabilityLots() { return { items: [], total: 0, page: 1, pageSize: 20, totalPages: 1, summary: {} }; },
    async listTraceabilitySerials() { return { items: [], total: 0, page: 1, pageSize: 20, totalPages: 1, summary: {} }; },
    async receiveStock() { return { receipt: { id: balanceId, number: "GRN-TEST" }, balanceId }; },
    async adjustStock() { return { adjustment: { id: balanceId, number: "ADJ-TEST", delta: 2 }, balanceId }; },
    async updateStockPolicy(_tenantId, receivedBalanceId, input) { return { balanceId: receivedBalanceId, ...input }; },
    async transferStock() { return { transfer: { id: balanceId, number: "TRF-TEST", quantity: 2 }, balanceId }; },
    async reconcileSerial() { return { serial: { id: balanceId, status: "QUARANTINED" } }; },
    ...overrides
  };
}

function app(inventoryService = service()) {
  return createApp({ inventoryService, tenantAccessResolver: resolveTenant,
    tenantPermissionAuthorization: allow });
}

test("inventory operation routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/inventory/options");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("warehouse creation normalizes India address data", async () => {
  let received;
  const response = await request(app(service({
    async createWarehouse(receivedTenantId, input) {
      received = { receivedTenantId, input };
      return { id: warehouseId, ...input, status: "ACTIVE" };
    }
  }))).post("/api/admin/v1/inventory/warehouses")
    .set("authorization", `Bearer ${token}`)
    .send({ code: "blr-01", name: "Bengaluru central", line1: "1 Market Road",
      city: "Bengaluru", stateCode: "ka", stateName: "Karnataka", postalCode: "560001" });
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.code, "BLR-01");
  assert.equal(received.input.stateCode, "KA");
});

test("goods receipt forwards batch and serial controls", async () => {
  let received;
  const response = await request(app(service({
    async receiveStock(receivedTenantId, input) { received = { receivedTenantId, input };
      return { receipt: { id: balanceId, number: "GRN-TEST" }, balanceId }; }
  }))).post("/api/admin/v1/inventory/receipts")
    .set("authorization", `Bearer ${token}`)
    .send({ warehouseId, offerId, quantity: "2", lotNumber: "LOT-01",
      expiresAt: "2027-01-01", serialNumbers: ["SN-01", "SN-02"] });
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.quantity, 2);
  assert.deepEqual(received.input.serialNumbers, ["SN-01", "SN-02"]);
});

test("stock adjustment requires an audit note", async () => {
  const response = await request(app()).post("/api/admin/v1/inventory/adjustments")
    .set("authorization", `Bearer ${token}`)
    .send({ balanceId, countedQuantity: 4, reasonCode: "CYCLE_COUNT", notes: "x" });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("stock policy accepts nullable reorder controls", async () => {
  let received;
  const response = await request(app(service({
    async updateStockPolicy(receivedTenantId, receivedBalanceId, input) {
      received = { receivedTenantId, receivedBalanceId, input };
      return { balanceId: receivedBalanceId, ...input };
    }
  }))).patch(`/api/admin/v1/inventory/${balanceId}/policy`)
    .set("authorization", `Bearer ${token}`)
    .send({ safetyStockQuantity: "3", reorderPointQuantity: "5", reorderQuantity: null });
  assert.equal(response.status, 200);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.receivedBalanceId, balanceId);
  assert.deepEqual({ ...received.input }, {
    safetyStockQuantity: 3, reorderPointQuantity: 5, reorderQuantity: null
  });
});

test("warehouse transfer normalizes quantity and lot selection", async () => {
  let received;
  const response = await request(app(service({
    async transferStock(receivedTenantId, input) {
      received = { receivedTenantId, input };
      return { transfer: { id: balanceId, number: "TRF-TEST", quantity: input.quantity } };
    }
  }))).post("/api/admin/v1/inventory/transfers")
    .set("authorization", `Bearer ${token}`)
    .send({ sourceBalanceId: balanceId, destinationWarehouseId: warehouseId,
      quantity: "2.5", notes: "Replenish dark store" });
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.quantity, 2.5);
  assert.equal(received.input.sourceLotId, null);
  assert.deepEqual(received.input.serialIds, []);
});

test("warehouse transfer accepts exact serial selections", async () => {
  let received;
  const serialId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b33";
  const response = await request(app(service({
    async transferStock(receivedTenantId, input) {
      received = { receivedTenantId, input };
      return { transfer: { id: balanceId, number: "TRF-SERIAL", quantity: input.quantity } };
    }
  }))).post("/api/admin/v1/inventory/transfers")
    .set("authorization", `Bearer ${token}`)
    .send({ sourceBalanceId: balanceId, destinationWarehouseId: warehouseId,
      quantity: 1, serialIds: [serialId], notes: "Move exact unit" });
  assert.equal(response.status, 201);
  assert.deepEqual(received.input.serialIds, [serialId]);
  assert.equal(received.input.quantity, 1);
});

test("traceability lot filters are normalized", async () => {
  let received;
  const response = await request(app(service({
    async listTraceabilityLots(receivedTenantId, input) {
      received = { receivedTenantId, input };
      return { items: [], total: 0, page: input.page, pageSize: input.pageSize, totalPages: 1, summary: {} };
    }
  }))).get("/api/admin/v1/inventory/traceability/lots?health=expiring&page=2&pageSize=10")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.health, "EXPIRING");
  assert.equal(received.input.page, 2);
});

test("serial reconciliation forwards a validated warehouse action", async () => {
  let received;
  const response = await request(app(service({
    async reconcileSerial(receivedTenantId, receivedSerialId, input) {
      received = { receivedTenantId, receivedSerialId, input };
      return { serial: { id: receivedSerialId, status: input.status } };
    }
  }))).patch(`/api/admin/v1/inventory/traceability/serials/${balanceId}`)
    .set("authorization", `Bearer ${token}`)
    .send({ status: "quarantined", reasonCode: "quality_hold", notes: "Inspect screen damage" });
  assert.equal(response.status, 200);
  assert.equal(received.receivedSerialId, balanceId);
  assert.equal(received.input.status, "QUARANTINED");
  assert.equal(received.input.reasonCode, "QUALITY_HOLD");
});
