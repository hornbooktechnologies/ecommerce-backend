import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";
import { createInboxService, createInboxWorker } from "../src/modules/notifications/inbox.service.js";
import { inboxSchemas } from "../src/modules/notifications/inbox.routes.js";

const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const sessionId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
test("inbox validation defaults to ten and rejects identity injection", () => {
  assert.deepEqual(inboxSchemas.list.validate({}).value, { filter: "ALL", page: 1, pageSize: 10 });
  for (const value of [{ recipientId: userId }, { page: 0 }, { pageSize: 500 }, { filter: "PRIVATE" }]) assert.ok(inboxSchemas.list.validate(value).error);
  assert.ok(inboxSchemas.mark.validate({ read: "false" }).error);
  assert.ok(inboxSchemas.all.validate({}).error);
});
test("expired or revoked admin sessions cannot access the inbox", async () => {
  const service = createInboxService({ dao: { activeSession: async () => false } });
  await assert.rejects(service.userScope({ actor: { userId, sessionId } }, "ADMIN"), e => e.status === 401);
});
test("admin and vendor permissions are scoped to the selected workspace", async () => {
  const service = createInboxService({ dao: { activeSession: async () => true } });
  const actor = { userId, sessionId };
  const assignments = [{ scopeType: "TENANT", scopeId: "tenant", permissions: ["order.read"] },
    { roleLevel: "VENDOR", scopeType: "MERCHANT", scopeId: "mine", permissions: ["vendor.order.read"] },
    { roleLevel: "VENDOR", scopeType: "MERCHANT", scopeId: "foreign", permissions: ["secret"] }];
  assert.deepEqual((await service.userScope({ actor, tenant: { tenantId: "tenant", assignments } }, "ADMIN")).permissions, ["order.read"]);
  assert.deepEqual((await service.userScope({ actor, vendor: { tenantId: "tenant", merchantId: "mine", assignments } }, "VENDOR")).permissions, ["vendor.order.read"]);
});
test("customer identity comes from the authenticated session, not a request identifier", async () => {
  const service = createInboxService({ storeResolver: async () => ({ tenantId: "tenant", storeId: "store" }),
    accounts: { session: async () => ({ customerId: "owner", status: "ACTIVE" }) } });
  await assert.rejects(service.customerScope({}, ""), e => e.status === 401);
  assert.deepEqual(await service.customerScope({}, "a".repeat(64)), { audience: "CUSTOMER", recipientId: "owner", tenantId: "tenant", storeId: "store" });
});
test("read mutation hides missing and foreign records behind the same 404", async () => {
  const service = createInboxService({ dao: { markRead: async () => false, markAllRead: async () => false } });
  await assert.rejects(service.mark({}, userId, true), e => e.code === "NOTIFICATION_NOT_FOUND");
  await assert.rejects(service.markAll({}, userId), e => e.code === "NOTIFICATION_NOT_FOUND");
});
test("worker commits success and rolls back failures before releasing its connection", async () => {
  for (const fails of [false, true]) {
    const calls = [], connection = { beginTransaction: async () => calls.push("begin"), commit: async () => calls.push("commit"),
      rollback: async () => calls.push("rollback"), release: () => calls.push("release") };
    const worker = createInboxWorker({ pool: { getConnection: async () => connection }, dao: { processNext: async () => { if (fails) throw new Error("DB unavailable"); return { status: "PROCESSED" }; } } });
    if (fails) await assert.rejects(worker.once()); else assert.equal((await worker.once()).status, "PROCESSED");
    assert.deepEqual(calls, ["begin", fails ? "rollback" : "commit", "release"]);
  }
});
test("all staff inbox endpoints require a bearer token", async () => {
  const app = createApp();
  for (const area of ["admin", "vendor", "platform"]) assert.equal((await request(app).get(`/api/${area}/v1/notifications`)).status, 401);
});
test("route contract validates input and makes responses non-cacheable", async () => {
  let received;
  const service = { userScope: async () => ({ recipientId: userId }),
    list: async (scope, input) => { received = { scope, input }; return { items: [], total: 0 }; },
    customerScope: async () => ({ recipientId: "customer" }) };
  const app = createApp({ inboxService: service, tenantAccessResolver: (_req, _res, next) => next() });
  const token = createAccessToken({ userId, sessionId });
  const result = await request(app).get("/api/admin/v1/notifications").set("authorization", `Bearer ${token}`);
  assert.equal(result.status, 200); assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(received.input.pageSize, 10); assert.equal(received.scope.recipientId, userId);
  assert.equal((await request(app).get(`/api/admin/v1/notifications?recipientId=${userId}`).set("authorization", `Bearer ${token}`)).status, 422);
  const customer = await request(app).get("/api/storefront/v1/HORNBOOK_RETAIL/stores/MAIN/account/notifications");
  assert.equal(customer.status, 200); assert.equal(received.scope.recipientId, "customer");
});
