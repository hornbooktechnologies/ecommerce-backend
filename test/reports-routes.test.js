import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const merchantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const token = createAccessToken({ userId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77",
  sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });
function resolveTenant(req, _res, next) { req.context = Object.freeze({ ...req.context,
  tenant: Object.freeze({ tenantId, assignments: [] }) }); next(); }
function allow() { return (_req, _res, next) => next(); }
function service(overrides = {}) { return {
  async getReport(_tenantId, filters) { return { reportType: filters.reportType, rows: [], summary: {}, trend: [],
    options: { warehouses: [], merchants: [] }, total: 0, page: filters.page, pageSize: filters.pageSize, totalPages: 1 }; },
  async exportReport() { return { filename: "sales.csv", csv: "Order,Total" }; }, ...overrides }; }
function app(reportsService = service()) { return createApp({ reportsService,
  tenantAccessResolver: resolveTenant, tenantPermissionAuthorization: allow }); }

test("reports require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/reports");
  assert.equal(response.status, 401); assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});
test("reports normalize filters and use the authenticated tenant", async () => {
  let received;
  const response = await request(app(service({ async getReport(receivedTenant, filters) {
    received = { tenantId: receivedTenant, filters }; return { reportType: filters.reportType, rows: [], summary: {},
      trend: [], options: { warehouses: [], merchants: [] }, total: 0, page: filters.page, pageSize: filters.pageSize, totalPages: 1 };
  } }))).get(`/api/admin/v1/reports?reportType=vendor&fromDate=2026-10-01&toDate=2026-10-22&merchantId=${merchantId}`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200); assert.equal(received.tenantId, tenantId);
  assert.equal(received.filters.reportType, "VENDOR"); assert.equal(received.filters.merchantId, merchantId);
  assert.equal(received.filters.page, 1); assert.equal(received.filters.pageSize, 10);
});
test("report CSV export sends an attachment", async () => {
  const response = await request(app()).get("/api/admin/v1/reports/export?reportType=sales&fromDate=2026-10-01&toDate=2026-10-22")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200); assert.match(response.headers["content-type"], /text\/csv/);
  assert.match(response.headers["content-disposition"], /sales\.csv/); assert.equal(response.text, "Order,Total");
});
test("reports reject unknown report types", async () => {
  const response = await request(app()).get("/api/admin/v1/reports?reportType=unknown").set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 422); assert.equal(response.body.error.code, "VALIDATION_FAILED");
});
