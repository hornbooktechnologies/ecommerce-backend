import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const ratingId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const productId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) }); next();
}
function allow() { return (_req, _res, next) => next(); }
function service(overrides = {}) {
  return { async listRatings(_tenantId, filters) { return { items: [], total: 0, page: filters.page,
    pageSize: filters.pageSize, totalPages: 1, summary: {} }; }, async listOptions() { return { products: [] }; },
  async getRating() { return { id: ratingId, status: "PENDING" }; },
  async moderateRating(_tenantId, _id, input) { return { id: ratingId, ...input }; }, ...overrides };
}
function app(ratingsService = service()) { return createApp({ ratingsService,
  tenantAccessResolver: resolveTenant, tenantPermissionAuthorization: allow }); }

test("rating routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/ratings");
  assert.equal(response.status, 401); assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("rating directory normalizes tenant-scoped filters", async () => {
  let received;
  const response = await request(app(service({ async listRatings(receivedTenant, filters) {
    received = { tenantId: receivedTenant, filters }; return { items: [], total: 0, page: filters.page,
      pageSize: filters.pageSize, totalPages: 1, summary: {} };
  } }))).get(`/api/admin/v1/ratings?search=Bottle&status=published&rating=5&productId=${productId}&page=2&pageSize=10`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual(received, { tenantId, filters: { search: "Bottle", status: "PUBLISHED", rating: 5,
    productId, page: 2, pageSize: 10 } });
});

test("rating moderation normalizes status and notes", async () => {
  let received;
  const response = await request(app(service({ async moderateRating(receivedTenant, receivedRating, input, context) {
    received = { tenantId: receivedTenant, ratingId: receivedRating, input, actorUserId: context.actorUserId };
    return { id: receivedRating, ...input };
  } }))).post(`/api/admin/v1/ratings/${ratingId}/moderate`).set("authorization", `Bearer ${token}`)
    .send({ status: "flagged", notes: " Suspected promotional content " });
  assert.equal(response.status, 200); assert.deepEqual(received, { tenantId, ratingId,
    input: { status: "FLAGGED", notes: "Suspected promotional content" }, actorUserId: userId });
});

test("hiding a rating requires a moderation note", async () => {
  const response = await request(app()).post(`/api/admin/v1/ratings/${ratingId}/moderate`)
    .set("authorization", `Bearer ${token}`).send({ status: "hidden", notes: "" });
  assert.equal(response.status, 422); assert.equal(response.body.error.code, "VALIDATION_FAILED");
});
