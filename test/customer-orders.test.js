import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createId, uuidToBuffer } from "../src/core/identifiers/uuid.js";
import { createCustomerAccountsService, digest } from "../src/modules/customer-accounts/customer-accounts.service.js";
import { orderSchemas } from "../src/modules/customer-accounts/customer-accounts.routes.js";
import { validate } from "../src/modules/customer-accounts/customer-accounts.validators.js";
import * as orderDao from "../src/modules/customer-accounts/customer-orders.dao.js";

const store = { tenantId: createId(), storeId: createId() }, customerId = createId(), orderId = createId(), token = "b".repeat(64);
function setup() {
  const calls = [];
  let active = true;
  const service = createCustomerAccountsService({ storeResolver: async () => store,
    transaction: async (_tenantId, operation) => operation({}),
    dao: { session: async ({ tenantId, tokenHash }) => active && tenantId === store.tenantId && tokenHash.equals(digest(token)) ? { customerId, status: "ACTIVE" } : null,
      findAccount: async () => {}, limit: async () => true, pruneExpired: async () => {} },
    orderDao: { listOrders: async (args) => { calls.push(args); return { items: [], pagination: { page: args.page, pageSize: args.pageSize } }; },
      readOrder: async (args) => { calls.push(args); return args.orderId === orderId ? { order: { id: orderId } } : null; } } });
  return { service, calls, revoke: () => { active = false; } };
}
test("order reads require a valid active customer session, including after revocation", async () => {
  const s = setup();
  for (const credential of ["", "admin.jwt", "a".repeat(64)]) await assert.rejects(s.service.orders(store, credential, { page: 1, pageSize: 10 }), { status: 401 });
  await assert.rejects(s.service.order({ ...store, tenantId: createId() }, token, { orderId }), { status: 401 });
  assert.equal(s.calls.length, 0);
  await s.service.order(store, token, { orderId });
  assert.equal(s.calls[0].customerId, customerId); assert.equal(s.calls[0].storeId, store.storeId);
  s.revoke(); await assert.rejects(s.service.order(store, token, { orderId }), { status: 401 });
});
test("order APIs validate pagination and reject supplied customer/store/tenant identities", async () => {
  assert.deepEqual(validate(orderSchemas.list, {}), { page: 1, pageSize: 10 });
  for (const input of [{ page: 0 }, { pageSize: 1000 }, { page: 1.5 }, { customerId }, { tenantId: store.tenantId }, { storeId: store.storeId }]) {
    assert.throws(() => validate(orderSchemas.list, input), { status: 422 });
  }
  assert.throws(() => validate(orderSchemas.read, { orderId: "not-an-id" }), { status: 422 });
  const s = setup(), app = createApp({ customerAccountsService: s.service });
  const base = "/api/storefront/v1/HORNBOOK_RETAIL/stores/MAIN/account/orders";
  const response = await request(app).post(`${base}/list`).set("Authorization", `Bearer ${token}`).send({}).expect(200);
  assert.equal(response.headers["cache-control"], "no-store"); assert.equal(response.body.data.pagination.pageSize, 10);
  await request(app).post(`${base}/read`).set("Authorization", `Bearer ${token}`).send({ orderId: createId() }).expect(404);
  await request(app).post(`${base}/list`).send({}).expect(401);
});
test("DAO applies all three ownership boundaries and deterministic pagination", async () => {
  const queries = [];
  const connection = { execute: async (sql, bindings) => { queries.push({ sql, bindings }); return sql.includes("SELECT COUNT(*) AS total") ? [[{ total: 11 }]] : [[]]; } };
  const result = await orderDao.listOrders({ ...store, customerId, page: 2, pageSize: 10, connection });
  assert.deepEqual(result.pagination, { page: 2, pageSize: 10, total: 11, totalPages: 2 });
  for (const { sql, bindings } of queries) {
    assert.match(sql, /o.tenant_id = \? AND o.store_id = \? AND o.customer_id = \?/);
    assert.deepEqual(bindings.slice(0, 3), [store.tenantId, store.storeId, customerId].map(uuidToBuffer));
    assert.match(sql, /o.status <> 'DRAFT'/);
  }
  assert.deepEqual(queries[1].bindings.slice(-2), [10, 10]);
  assert.match(queries[1].sql, /ORDER BY o.placed_at DESC, o.id DESC/);
  queries.length = 0;
  assert.equal(await orderDao.readOrder({ ...store, customerId, orderId, connection }), null);
  assert.equal(queries.length, 1, "foreign/missing order stops before fetching any detail");
});
test("customer projection omits internal notes, staff and seller financial information", async () => {
  const row = { id: uuidToBuffer(orderId), status: "PLACED", shipping_address_snapshot: JSON.stringify({ line1: "Safe road", secret: "DO_NOT_EXPOSE" }),
    internal_notes: "DO_NOT_EXPOSE", merchant_payable_total: "DO_NOT_EXPOSE", changed_by_name: "DO_NOT_EXPOSE" };
  let call = 0;
  const connection = { execute: async () => {
    call++;
    return [[...(call === 1 ? [row] : call === 4 ? [{ ...row, status_type: "ORDER", new_status: "PLACED", notes: "DO_NOT_EXPOSE", changed_at: "invalid" }] : [])]];
  } };
  const result = await orderDao.readOrder({ ...store, customerId, orderId, connection });
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE/);
  assert.equal(result.address.line1, "Safe road"); assert.equal(result.history[0].at, null);
});

test("invoice DAO checks customer, store, tenant, order and issued type before reading PDF data", async () => {
  const documentId = createId(), calls = [];
  const connection = { execute: async (sql, bindings) => { calls.push({ sql, bindings }); return [[]]; } };
  assert.equal(await orderDao.readInvoice({ ...store, customerId, orderId, documentId, connection }), null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /o.tenant_id = \? AND o.store_id = \? AND o.customer_id = \?/);
  assert.match(calls[0].sql, /o.id = \? AND td.document_type = 'TAX_INVOICE' AND td.status = 'ISSUED'/);
  assert.match(calls[0].sql, /AND td.id = \?/);
  assert.deepEqual(calls[0].bindings, [store.tenantId, store.storeId, customerId, orderId, documentId].map(uuidToBuffer));
});

test("invoice API returns private PDF attachments, rejects unauthorized/unissued documents and injected identities", async () => {
  const documentId = createId(); let active = true, documentStatus = "ISSUED", type = "TAX_INVOICE", rendered = 0;
  const service = createCustomerAccountsService({ storeResolver: async () => store,
    transaction: async (_tenant, fn) => fn({}),
    dao: { session: async ({ tokenHash }) => active && tokenHash.equals(digest(token)) ? { customerId, status: "ACTIVE" } : null,
      findAccount: async () => {}, limit: async () => true, pruneExpired: async () => {} },
    orderDao: { readInvoice: async (args) => {
      assert.equal(args.customerId, customerId); assert.equal(args.tenantId, store.tenantId); assert.equal(args.storeId, store.storeId);
      return args.documentId === documentId && args.orderId === orderId ? { documentNumber: 'INV/2026/001', status: documentStatus,
        documentType: type, seller: { legalName: 'Vendor Ltd' }, issuedByName: 'PRIVATE_STAFF' } : null;
    } },
    pdfRenderer: async (detail) => { rendered++; assert.equal(detail.issuedByName, 'Vendor Ltd'); return Buffer.from('%PDF-1.4\nfixture'); } });
  const app = createApp({ customerAccountsService: service });
  const url = '/api/storefront/v1/HORNBOOK_RETAIL/stores/MAIN/account/orders/invoice';
  const send = (input = { orderId, documentId }, credential = token) => request(app).post(url).set('Authorization', `Bearer ${credential}`).send(input);
  const response = await send().expect(200);
  assert.match(response.headers['content-type'], /application\/pdf/);
  assert.equal(response.headers['content-disposition'], 'attachment; filename="tax-invoice-INV-2026-001.pdf"');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(response.body.toString(), /^%PDF-/);
  await send({ orderId, documentId, customerId }).expect(422);
  await send({ orderId, documentId: 'invalid' }).expect(422);
  await send({ orderId: createId(), documentId }).expect(404);
  await send({ orderId, documentId: createId() }).expect(404);
  await send(undefined, 'admin.jwt').expect(401);
  for (const status of ['DRAFT', 'CANCELLED']) { documentStatus = status; await send().expect(404); }
  documentStatus = 'ISSUED'; type = 'CREDIT_NOTE'; await send().expect(404);
  active = false; await send().expect(401);
  assert.equal(rendered, 1, 'No PDF rendered on rejected requests');
});
