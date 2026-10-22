import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const merchantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const ruleId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b44";
const orderId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b33";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) }); next();
}
function allow() { return (_req, _res, next) => next(); }
function service(overrides = {}) {
  return { async getWorkspace(_tenantId, filters) { return { entries: [], rules: [], merchants: [], stores: [],
    summary: {}, total: 0, page: filters.page, pageSize: filters.pageSize, totalPages: 1 }; },
  async createRule(_tenantId, input) { return { id: ruleId, ...input }; },
  async updateRule(_tenantId, _ruleId, input) { return { id: ruleId, ...input }; }, ...overrides };
}
function app(marketplaceFinanceService = service()) {
  return createApp({ marketplaceFinanceService, tenantAccessResolver: resolveTenant,
    tenantPermissionAuthorization: allow });
}

test("marketplace finance requires authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/finance");
  assert.equal(response.status, 401); assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("finance workspace normalizes ledger filters", async () => {
  let received;
  const response = await request(app(service({ async getWorkspace(receivedTenant, filters) {
    received = { tenantId: receivedTenant, filters }; return { entries: [], rules: [], merchants: [], stores: [],
      summary: {}, total: 0, page: filters.page, pageSize: filters.pageSize, totalPages: 1 };
  } }))).get(`/api/admin/v1/finance?merchantId=${merchantId}&entryType=sale_credit&settlementStatus=unsettled&page=2&pageSize=10`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200); assert.deepEqual({ ...received, filters: { ...received.filters } }, { tenantId, filters: { search: "", merchantId,
    entryType: "SALE_CREDIT", settlementStatus: "UNSETTLED", page: 2, pageSize: 10 } });
});

test("commission rule creation normalizes India-first percentage terms", async () => {
  let received;
  const response = await request(app(service({ async createRule(receivedTenant, input) {
    received = { tenantId: receivedTenant, input }; return { id: ruleId, ...input };
  } }))).post("/api/admin/v1/finance/commission-rules").set("authorization", `Bearer ${token}`).send({
    scopeType: "merchant", merchantId, commissionType: "percentage", commissionPercent: 9.5,
    appliesOn: "taxable_value", priority: 20, effectiveFrom: "2026-10-22T00:00:00.000Z"
  });
  assert.equal(response.status, 201); assert.equal(received.tenantId, tenantId);
  assert.equal(received.input.scopeType, "MERCHANT"); assert.equal(received.input.commissionPercent, 9.5);
  assert.equal(received.input.commissionAmount, null); assert.equal(received.input.status, "ACTIVE");
});

test("commission rules reject a merchant scope without a merchant", async () => {
  const response = await request(app()).post("/api/admin/v1/finance/commission-rules")
    .set("authorization", `Bearer ${token}`).send({ scopeType: "MERCHANT", commissionType: "PERCENTAGE",
      commissionPercent: 8, effectiveFrom: "2026-10-22T00:00:00.000Z" });
  assert.equal(response.status, 422); assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("ledger reconciliation remains an explicit managed action", async () => {
  let receivedTenant;
  const response = await request(app(service({ async reconcileLedger(value) {
    receivedTenant = value; return { eligibleOrders: 1, postedSellerOrders: 1, sellerOrderIds: [orderId], hasMore: false };
  } }))).post("/api/admin/v1/finance/ledger/reconcile").set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200); assert.equal(receivedTenant, tenantId);
  assert.equal(response.body.data.postedSellerOrders, 1);
});
