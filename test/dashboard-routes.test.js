import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const token = createAccessToken({ userId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77",
  sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) });
  next();
}
function allow() { return (_req, _res, next) => next(); }
function app(dashboardService = { async getOverview() { return { metrics: {}, salesTrend: [], orderMix: [], queue: [], activity: [] }; } }) {
  return createApp({ dashboardService, tenantAccessResolver: resolveTenant,
    tenantPermissionAuthorization: allow });
}

test("dashboard requires authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/dashboard");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("dashboard uses authenticated tenant scope", async () => {
  let receivedTenantId;
  const response = await request(app({ async getOverview(value) {
    receivedTenantId = value;
    return { metrics: { ordersToday: 4 }, salesTrend: [], orderMix: [], queue: [], activity: [] };
  } })).get("/api/admin/v1/dashboard").set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.equal(receivedTenantId, tenantId);
  assert.equal(response.body.data.metrics.ordersToday, 4);
});
