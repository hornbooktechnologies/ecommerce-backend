import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const supplierId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b11";
const warehouseId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b22";
const offerId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b33";
const orderId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b44";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });
function resolveTenant(req, _res, next) { req.context = Object.freeze({ ...req.context,
  tenant: Object.freeze({ tenantId, assignments: [] }) }); next(); }
function allow() { return (_req, _res, next) => next(); }
function service(overrides = {}) { return { async listOptions() { return { suppliers: [], warehouses: [], offers: [] }; },
  async listSuppliers(_tenant, filters) { return { items: [], total: 0, ...filters, totalPages: 1 }; },
  async createSupplier(_tenant, input) { return { id: supplierId, ...input }; },
  async updateSupplier(_tenant, _id, input) { return { id: supplierId, ...input }; },
  async listPurchaseOrders(_tenant, filters) { return { items: [], total: 0, ...filters, totalPages: 1, summary: {} }; },
  async getPurchaseOrder() { return { id: orderId }; }, async createPurchaseOrder(_tenant, input) { return { id: orderId, ...input }; },
  async approvePurchaseOrder() { return { id: orderId, status: "APPROVED" }; },
  async cancelPurchaseOrder() { return { id: orderId, status: "CANCELLED" }; }, ...overrides }; }
const app = (procurementService = service()) => createApp({ procurementService,
  tenantAccessResolver: resolveTenant, tenantPermissionAuthorization: allow });

test("procurement routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/purchase-orders");
  assert.equal(response.status, 401); assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("purchase-order filters are normalized", async () => {
  let received;
  const response = await request(app(service({ async listPurchaseOrders(receivedTenant, filters) {
    received = { tenantId: receivedTenant, filters }; return { items: [], total: 0, ...filters, totalPages: 1, summary: {} };
  } }))).get("/api/admin/v1/purchase-orders?search=Acme&status=partially_received&page=2&pageSize=10")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200); assert.equal(received.tenantId, tenantId);
  assert.deepEqual({ ...received.filters }, { search: "Acme", status: "PARTIALLY_RECEIVED", page: 2, pageSize: 10 });
});

test("purchase-order creation validates and normalizes lines", async () => {
  let input;
  const response = await request(app(service({ async createPurchaseOrder(_tenant, received) { input = received; return { id: orderId }; } })))
    .post("/api/admin/v1/purchase-orders").set("authorization", `Bearer ${token}`).send({ supplierId, warehouseId,
      items: [{ offerId, quantity: "2", unitCost: "120.50", taxRate: "18" }] });
  assert.equal(response.status, 201); assert.equal(input.items[0].quantity, 2);
  assert.equal(input.items[0].unitCost, 120.5); assert.equal(input.items[0].taxRate, 18);
});

test("supplier creation keeps uppercase India tax identifiers", async () => {
  let input;
  const response = await request(app(service({ async createSupplier(_tenant, received) { input = received; return { id: supplierId }; } })))
    .post("/api/admin/v1/suppliers").set("authorization", `Bearer ${token}`).send({ code: " acme ",
      legalName: "Acme Supply Private Limited", displayName: "Acme Supply", gstin: "29abcde1234f1z5", pan: "abcde1234f" });
  assert.equal(response.status, 201); assert.equal(input.code, "ACME"); assert.equal(input.gstin, "29ABCDE1234F1Z5");
  assert.equal(input.pan, "ABCDE1234F");
});
