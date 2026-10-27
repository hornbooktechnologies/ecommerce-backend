import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createId, uuidToBuffer } from "../src/core/identifiers/uuid.js";
import { createCustomerAccountsService, digest } from "../src/modules/customer-accounts/customer-accounts.service.js";
import { orderSchemas } from "../src/modules/customer-accounts/customer-accounts.routes.js";
import { validate } from "../src/modules/customer-accounts/customer-accounts.validators.js";
import * as reviewDao from "../src/modules/customer-accounts/customer-reviews.dao.js";

const store = { tenantId: createId(), storeId: createId() }, customerId = createId(), productId = createId();
const token = "c".repeat(64);
const input = { orderId: createId(), orderItemId: createId(), rating: 4, title: "Good quality", review: "Arrived in good condition and works well." };
function setup() {
  const state = { active: true, owned: true, eligible: true, previous: null, inserts: [], audit: [], locks: 0 };
  const service = createCustomerAccountsService({ storeResolver: async () => store,
    transaction: async (_tenant, fn) => fn({}),
    dao: { session: async ({ tenantId, tokenHash }) => state.active && tenantId === store.tenantId && tokenHash.equals(digest(token))
      ? { customerId, status: "ACTIVE", firstName: "Test", email: "customer@example.invalid" } : null,
    findAccount: async ({ lock }) => { assert.equal(lock, true); state.locks++; },
    limit: async () => true, pruneExpired: async () => {}, audit: async (args) => state.audit.push(args) },
    reviewDao: {
      purchase: async (args) => { assert.equal(args.customerId, customerId); assert.equal(args.storeId, store.storeId);
        assert.equal(args.tenantId, store.tenantId); return state.owned ? { productId, eligible: state.eligible } : null; },
      existing: async () => state.previous,
      insert: async (args) => { state.inserts.push(args); state.previous = { id: args.reviewId, status: "PENDING" }; },
    } });
  return { state, service };
}

test("review schema rejects impersonation, publication flags, invalid scores and oversized text", () => {
  for (const extra of [{ customerId }, { productId }, { verifiedPurchase: true }, { status: "PUBLISHED" },
    { rating: 0 }, { rating: 6 }, { rating: 1.5 }, { review: "short" }, { review: "x".repeat(3001) }, { title: "x".repeat(191) }]) {
    assert.throws(() => validate(orderSchemas.review, { ...input, ...extra }), { status: 422 });
  }
  assert.equal(validate(orderSchemas.review, { ...input, title: " Good " }).title, "Good");
});

test("reviews require an active session, item ownership and completed delivery", async () => {
  const { state, service } = setup();
  for (const credential of ["", "admin.jwt", "b".repeat(64)]) await assert.rejects(service.review(store, credential, input), { status: 401 });
  await assert.rejects(service.review({ ...store, tenantId: createId() }, token, input), { status: 401 });
  state.owned = false; await assert.rejects(service.review(store, token, input), { status: 404 });
  state.owned = true; state.eligible = false; await assert.rejects(service.review(store, token, input), { code: "REVIEW_NOT_ELIGIBLE", status: 422 });
  state.active = false; await assert.rejects(service.review(store, token, input), { status: 401 });
  assert.equal(state.inserts.length, 0);
});

test("submissions are pending, audited, account locked and retry safe without overwriting moderation", async () => {
  const { state, service } = setup();
  const first = await service.review(store, token, input);
  assert.equal(first.review.status, "PENDING");
  assert.equal(state.inserts[0].productId, productId);
  assert.equal(state.inserts[0].account.email, "customer@example.invalid");
  assert.equal(state.audit[0].action, "CUSTOMER_PRODUCT_REVIEW_SUBMITTED");
  const second = await service.review(store, token, { ...input, rating: 1 });
  assert.deepEqual(second.review, first.review);
  state.previous.status = "HIDDEN";
  assert.equal((await service.review(store, token, input)).review.status, "HIDDEN");
  assert.equal(state.inserts.length, 1); assert.equal(state.audit.length, 1); assert.equal(state.locks, 3);
});

test("review endpoint validates payloads and never accepts admin credentials", async () => {
  const { service } = setup(); const app = createApp({ customerAccountsService: service });
  const url = "/api/storefront/v1/HORNBOOK_RETAIL/stores/MAIN/account/orders/review";
  await request(app).post(url).send(input).expect(401);
  await request(app).post(url).set("Authorization", "Bearer admin.jwt").send(input).expect(401);
  await request(app).post(url).set("Authorization", `Bearer ${token}`).send({ ...input, customerId }).expect(422);
  const response = await request(app).post(url).set("Authorization", `Bearer ${token}`).send(input).expect(200);
  assert.equal(response.headers["cache-control"], "no-store"); assert.equal(response.body.data.review.status, "PENDING");
});

test("review DAO binds tenant/store/customer/order/item and derives verified purchase on server", async () => {
  const calls = []; const connection = { execute: async (sql, bindings) => { calls.push({ sql, bindings }); return [[]]; } };
  assert.equal(await reviewDao.purchase({ ...store, ...input, customerId, connection }), null);
  assert.deepEqual(calls[0].bindings, [store.tenantId, store.storeId, customerId, input.orderId, input.orderItemId].map(uuidToBuffer));
  assert.match(calls[0].sql, /FOR UPDATE/); assert.match(calls[0].sql, /f.status = 'COMPLETED'/);
  assert.match(calls[0].sql, /fi.order_item_id = i.id/);
  await reviewDao.insert({ ...store, ...input, input, customerId, productId, reviewId: createId(), account: { firstName: "Test", email: "a@example.invalid" }, connection });
  assert.match(calls[1].sql, /'PENDING', 'STOREFRONT', 1/);
});
