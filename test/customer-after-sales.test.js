import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createId, uuidToBuffer } from "../src/core/identifiers/uuid.js";
import { createCustomerAfterSalesService } from "../src/modules/customer-accounts/customer-after-sales.service.js";
import { createCustomerAccountsService } from "../src/modules/customer-accounts/customer-accounts.service.js";
import * as afterDao from "../src/modules/customer-accounts/customer-after-sales.dao.js";
import { orderSchemas } from "../src/modules/customer-accounts/customer-accounts.routes.js";
import { validate } from "../src/modules/customer-accounts/customer-accounts.validators.js";

const args = { tenantId: createId(), storeId: createId(), customerId: createId(), orderId: createId(), connection: {} };
const itemId = createId(), serialId = createId();
const input = { orderItemId: itemId, requestId: createId(), returnType: "RETURN", quantity: 1, reasonCode: "QUALITY", customerComments: "", serialIds: [] };
function setup() {
  const state = { owned: true, status: "PROCESSING", dispatched: false, cases: [], receipts: new Map(), created: 0, cancelled: 0,
    item: { id: itemId, name: "Shirt", variant: "Blue / M", quantity: 2, status: "FULFILLED", returnable: true, windowDays: 7,
      vertical: "CLOTHING", fractional: false, deliveredAt: "2026-10-20T12:00:00.000Z", checkedAt: "2026-10-22T12:00:00.000Z" } };
  const service = createCustomerAfterSalesService({
    dao: { ownedOrder: async (scope) => { assert.equal(scope.customerId, args.customerId); return state.owned ? { status: state.status } : null; },
      items: async () => [state.item], cases: async () => state.cases,
      serials: async () => [{ id: serialId, orderItemId: itemId, number: "SERIAL-1" }],
      receipt: async ({ key }) => state.receipts.get(key), saveReceipt: async (entry) => state.receipts.set(entry.key, entry), audit: async () => {} },
    orderDao: { hasDispatchedFulfillment: async () => state.dispatched },
    orderFactory: ({ transaction }) => ({ transitionOrder: async (_tenant, _order, data) => transaction(args.tenantId, async (connection) => {
      assert.equal(connection, args.connection); assert.equal(data.status, "CANCELLED");
      if (state.dispatched) throw Object.assign(new Error("Dispatched"), { status: 409 });
      state.cancelled++; state.status = "CANCELLED";
    }) }),
    returnFactory: ({ transaction }) => ({ createReturn: async () => transaction(args.tenantId, async (connection) => {
      assert.equal(connection, args.connection); state.created++;
      return { request: { id: createId(), returnNumber: "RET-TEST", internalNotes: "PRIVATE" } };
    }) }),
  });
  return { state, service };
}

test("after-sales schema rejects customer/status/refund injection and invalid quantities", () => {
  for (const extra of [{ customerId: args.customerId }, { status: "APPROVED" }, { refundAmount: 100 }, { quantity: 0 }, { quantity: -1 }, { serialIds: [serialId, serialId] }]) {
    assert.throws(() => validate(orderSchemas.return, { ...input, orderId: args.orderId, ...extra }), { status: 422 });
  }
  assert.throws(() => validate(orderSchemas.cancel, { orderId: args.orderId, reason: "x" }), { status: 422 });
});

test("cancellation checks ownership and status and delegates dispatch/stock handling once", async () => {
  const { state, service } = setup();
  state.owned = false; await assert.rejects(service.cancel(args, { reason: "Changed mind" }), { status: 404 });
  state.owned = true; state.status = "COMPLETED"; await assert.rejects(service.cancel(args, { reason: "Changed mind" }), { status: 409 });
  state.status = "PROCESSING"; state.dispatched = true; await assert.rejects(service.cancel(args, { reason: "Changed mind" }), { status: 409 });
  state.dispatched = false;
  await service.cancel(args, { reason: "Changed mind" }); await service.cancel(args, { reason: "Retry" });
  assert.equal(state.cancelled, 1);
});

test("return eligibility enforces delivery, configured window, remaining quantities and fractional policy", async () => {
  const { state, service } = setup();
  const initial = { ...state.item };
  for (const update of [{ status: "SHIPPED" }, { returnable: false }, { windowDays: null }, { windowDays: 0 }, { checkedAt: "2026-10-28T12:00:00Z" }]) {
    state.item = { ...initial, ...update };
    await assert.rejects(service.requestReturn(args, input), { status: 409 });
  }
  state.item = initial;
  await assert.rejects(service.requestReturn(args, { ...input, quantity: 3 }), { status: 422 });
  await assert.rejects(service.requestReturn(args, { ...input, quantity: 0.5 }), { status: 422 });
  state.cases = [{ id: createId(), status: "APPROVED", items: [{ orderItemId: itemId, quantity: 2 }] }];
  await assert.rejects(service.requestReturn(args, input), { status: 409 });
  state.cases[0].status = "REJECTED";
  assert.equal((await service.read(args)).items[0].remaining, 2);
  state.item.fractional = true;
  await service.requestReturn(args, { ...input, quantity: 0.5 }); assert.equal(state.created, 1);
});

test("exchanges are clothing-only and serials cannot belong to other items or active requests", async () => {
  const { state, service } = setup();
  state.item.vertical = "GENERAL";
  await assert.rejects(service.requestReturn(args, { ...input, returnType: "EXCHANGE" }), { status: 422 });
  await assert.rejects(service.requestReturn(args, { ...input, serialIds: [createId()] }), { status: 409 });
  state.cases = [{ status: "REQUESTED", items: [{ orderItemId: itemId, quantity: 1, serialId }] }];
  await assert.rejects(service.requestReturn(args, { ...input, serialIds: [serialId] }), { status: 409 });
  assert.equal(state.created, 0);
});

test("return receipts are scoped and retry-safe and never expose admin return details", async () => {
  const { state, service } = setup();
  const result = await service.requestReturn(args, input);
  assert.deepEqual(await service.requestReturn(args, input), result);
  await assert.rejects(service.requestReturn(args, { ...input, quantity: 2 }), { code: "RETURN_REQUEST_CHANGED" });
  assert.equal(state.created, 1); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.equal([...state.receipts.keys()][0], `${args.customerId}:${args.storeId}:${input.requestId}`);
});

test("after-sales routes authenticate before exposing options or performing actions", async () => {
  const seen = [];
  const service = createCustomerAccountsService({ storeResolver: async () => args,
    dao: { limit: async () => true, pruneExpired: async () => {}, session: async () => null },
    afterSales: { read: async () => seen.push("read"), cancel: async () => seen.push("cancel"), requestReturn: async () => seen.push("return") } });
  const app = createApp({ customerAccountsService: service });
  const base = "/api/storefront/v1/HORNBOOK_RETAIL/stores/MAIN/account/orders";
  await request(app).post(`${base}/after-sales`).send({ orderId: args.orderId }).expect(401);
  await request(app).post(`${base}/cancel`).send({ orderId: args.orderId, reason: "Changed mind" }).expect(401);
  await request(app).post(`${base}/return`).send({ ...input, orderId: args.orderId }).expect(401);
  assert.deepEqual(seen, []);
});

test("after-sales DAO enforces all ownership boundaries and locks mutation reads", async () => {
  const calls = []; const connection = { execute: async (sql, bindings) => { calls.push({ sql, bindings }); return [[]]; } };
  assert.equal(await afterDao.ownedOrder({ ...args, connection, lock: true }), null);
  assert.match(calls[0].sql, /o.tenant_id = \? AND o.store_id = \? AND o.customer_id = \? AND o.id = \?/);
  assert.match(calls[0].sql, /FOR UPDATE/);
  assert.deepEqual(calls[0].bindings, [args.tenantId, args.storeId, args.customerId, args.orderId].map(uuidToBuffer));
});
