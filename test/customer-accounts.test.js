import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createCustomerAccountsService, digest } from "../src/modules/customer-accounts/customer-accounts.service.js";
import { schemas, validate } from "../src/modules/customer-accounts/customer-accounts.validators.js";
import { hashPassword } from "../src/core/security/password.js";
import { readFile } from "node:fs/promises";
import { createCustomersService } from "../src/modules/customers/customers.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const storeId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const customerId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const scope = { tenantId, storeId, tenantCode: "TEST", storeCode: "MAIN" };
const token = "a".repeat(64);
const transaction = (_tenantId, operation) => operation({});

test("customer inputs reject privilege fields, weak passwords and invalid India addresses", () => {
  assert.equal(validate(schemas.login, { email: " TEST@example.com ", password: "password" }).email, "test@example.com");
  assert.throws(() => validate(schemas.register, { email: "a@b.com", firstName: "A", tenantId }), { status: 422 });
  assert.throws(() => validate(schemas.redeem, { token, newPassword: "short" }), { status: 422 });
  assert.throws(() => validate(schemas.profile, { firstName: "A", status: "ACTIVE", email: "a@b.com" }), { status: 422 });
  assert.throws(() => validate(schemas.address, { contactName: "A", line1: "Road", city: "Surat", stateCode: "XX", postalCode: "000000" }), { status: 422 });
  assert.throws(() => validate(schemas.register, { email: "usér@example.com", firstName: "A" }), { status: 422 });
});

test("admin customer edits cannot replace a verified storefront identity", async () => {
  const service = createCustomersService({ transaction, dao: {
    getCustomer: async () => ({ email: "verified@example.com" }), hasStorefrontAccount: async () => true
  } });
  await assert.rejects(service.updateCustomer(tenantId, customerId, { email: "replacement@example.com" }, {}), { code: "VERIFIED_CUSTOMER_EMAIL_LOCKED", status: 422 });
});

test("customer API never accepts admin bearer tokens and requires ownership for addresses", async () => {
  const seen = [];
  const service = { scope: async () => scope, ipLimit: async () => {},
    me: async (_scope, credential) => { seen.push(credential); return {}; },
    address: async (_scope, credential, id) => { seen.push(credential, id); return {}; } };
  const app = createApp({ customerAccountsService: service });
  const base = "/api/storefront/v1/TEST/stores/MAIN/account";
  await request(app).get(`${base}/me`).set("Authorization", "Bearer admin.jwt.token").expect(200);
  assert.equal(seen[0], "");
  await request(app).delete(`${base}/addresses/${customerId}`).set("Authorization", `Bearer ${token}`).expect(200);
  assert.equal(seen[1], token); assert.equal(seen[2], customerId);
  await request(app).post(`${base}/register`).send({ email: "invalid" }).expect(422);
});

test("session lookup is tenant scoped and blocks suspended or deleted customers", async () => {
  let active = true; const calls = [];
  const service = createCustomerAccountsService({ dao: {
    session: async (input) => { calls.push(input); return { customerId, status: active ? "ACTIVE" : "BLOCKED", email: "a@b.com", firstName: "A" }; },
    addresses: async () => []
  } });
  const result = await service.me(scope, token);
  assert.equal(result.customer.id, customerId); assert.equal(result.customer.passwordHash, undefined);
  assert.equal(calls[0].tenantId, tenantId); assert.deepEqual(calls[0].tokenHash, digest(token));
  active = false;
  await assert.rejects(service.me(scope, token), { status: 401 });
  await assert.rejects(service.me(scope, "admin.jwt"), { status: 401 });
});

test("login throttle is committed outside the password transaction and sessions contain only hashes", async () => {
  const passwordHash = await hashPassword("ValidPassword123!"); let attempts = 0; let session;
  const service = createCustomerAccountsService({ transaction, dao: {
    limit: async () => ++attempts < 3,
    findAccount: async () => ({ customerId, email: "a@b.com", status: "ACTIVE", passwordHash }),
    insertSession: async (value) => { session = value; }, audit: async () => {}
  } });
  await assert.rejects(service.login(scope, { email: "a@b.com", password: "wrong" }), { status: 401 });
  const result = await service.login(scope, { email: "a@b.com", password: "ValidPassword123!" });
  assert.equal(result.expiresIn, 3600); assert.deepEqual(session.tokenHash, digest(result.sessionToken));
  assert.equal(result.customer.passwordHash, undefined);
  await assert.rejects(service.login(scope, { email: "a@b.com", password: "ValidPassword123!" }), { status: 429 });
});

test("email requests never return tokens and existing accounts do not receive new registration credentials", async () => {
  let exists = false; let saved; const sent = [];
  const service = createCustomerAccountsService({ transaction, mailer: { ready: () => {}, send: async (mail) => sent.push(mail) }, dao: {
    limit: async () => true, lockTenant: async () => {}, findAccount: async () => exists ? { customerId, status: "ACTIVE" } : null,
    findCustomers: async () => [], insertToken: async (value) => { saved = value; }
  } });
  const first = await service.register(scope, { email: "a@b.com", firstName: "A" });
  assert.equal(sent.length, 1); assert.deepEqual(saved.tokenHash, digest(sent[0].token));
  assert.equal(JSON.stringify(first).includes(sent[0].token), false);
  exists = true;
  assert.deepEqual(await service.register(scope, { email: "a@b.com", firstName: "A" }), first);
  assert.equal(sent.length, 1);
});

test("unverified, expired and cross-store email tokens cannot create accounts", async () => {
  let args;
  const service = createCustomerAccountsService({ transaction, dao: {
    lockTenant: async () => {}, findToken: async (input) => { args = input; return null; }
  } });
  await assert.rejects(service.verify(scope, { token, newPassword: "ValidPassword123!" }), { status: 400 });
  assert.equal(args.storeId, storeId); assert.equal(args.tenantId, tenantId); assert.equal(args.purpose, "REGISTER");
});

test("a different customer's address is not editable or removable", async () => {
  const owner = { customerId, status: "ACTIVE" };
  const service = createCustomerAccountsService({ transaction, dao: {
    session: async () => owner, findAccount: async () => owner, addresses: async () => []
  } });
  await assert.rejects(service.address(scope, token, storeId, {}, false), { status: 404 });
  await assert.rejects(service.address(scope, token, storeId, null, true), { status: 404 });
});

test("password changes revoke sessions and reset links after verifying the current password", async () => {
  const owner = { customerId, email: "a@b.com", status: "ACTIVE", passwordHash: await hashPassword("ValidPassword123!") };
  const calls = [];
  const service = createCustomerAccountsService({ transaction, dao: {
    limit: async () => true, session: async () => owner, findAccount: async () => owner,
    password: async () => calls.push("password"), revoke: async () => calls.push("revoke"),
    deleteTokens: async () => calls.push("tokens"), audit: async () => calls.push("audit")
  } });
  await assert.rejects(service.changePassword(scope, token, { currentPassword: "wrong", newPassword: "DifferentPassword123!" }), { status: 422 });
  assert.deepEqual(calls, []);
  await service.changePassword(scope, token, { currentPassword: "ValidPassword123!", newPassword: "DifferentPassword123!" });
  assert.deepEqual(calls, ["password", "revoke", "tokens", "audit"]);
});

test("DAO lookups bind both customer ownership and tenant parameters", async () => {
  const source = await readFile(new URL("../src/modules/customer-accounts/customer-accounts.dao.js", import.meta.url), "utf8");
  assert.match(source, /ca.tenant_id = \? AND ca.customer_id = \?/);
  assert.match(source, /s.tenant_id = \? AND s.token_hash = \? AND s.expires_at > UTC_TIMESTAMP/);
  assert.match(source, /tenant_id = \? AND store_id = \? AND token_hash = \? AND purpose = \?/);
});
