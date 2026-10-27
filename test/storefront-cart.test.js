import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createId } from "../src/core/identifiers/uuid.js";
import { createStorefrontCartService, quantityIssue } from "../src/modules/storefront-cart/storefront-cart.service.js";

const store = { tenantId: createId(), storeId: createId(), currency: "INR" };
const offerId = createId();
function setup() {
  const rows = new Map();
  const key = (input) => `${input.tenantId}:${input.storeId}:${input.ownerHash.toString("hex")}`;
  let product = { offerId, price: 12.35, availableQuantity: 10, minimumOrderQuantity: .25, quantityStep: .25, maximumOrderQuantity: 8, uom: "KG" };
  const dao = {
    ensure: async (input) => { if (!rows.has(key(input))) rows.set(key(input), { items: [], revision: 0, legacyImported: false }); },
    read: async (input) => rows.has(key(input)) ? structuredClone(rows.get(key(input))) : null,
    save: async (input) => rows.set(key(input), { items: structuredClone(input.items), legacyImported: input.legacyImported, revision: rows.get(key(input)).revision + 1 }),
  };
  const customerId = createId();
  const service = createStorefrontCartService({ dao, storeResolver: async () => store,
    offers: async ({ offerIds }) => product && offerIds.includes(offerId) ? [product] : [], transaction: async (_id, fn) => fn({}),
    accountDao: { limit: async () => true, session: async () => ({ customerId, status: "ACTIVE" }), findAccount: async () => ({ customerId }) } });
  return { service, change: (value) => { product = value ? { ...product, ...value } : null; } };
}
test("decimal quantity rules enforce minimum, step, maximum and sellable stock", () => {
  const p = { minimumOrderQuantity: .1, quantityStep: .1, maximumOrderQuantity: 2, availableQuantity: 3, uom: "KG" };
  assert.equal(quantityIssue(p, .3), null);
  assert.match(quantityIssue(p, .35), /steps/);
  assert.match(quantityIssue(p, .05), /at least/);
  assert.match(quantityIssue(p, 2.1), /Only 2/);
  assert.match(quantityIssue({ ...p, availableQuantity: 0 }, .1), /out of stock/);
  assert.match(quantityIssue(null, 1), /no longer available/);
});
test("API prices replace snapshots, stale revisions fail and unavailable items remain removable", async () => {
  const { service, change } = setup();
  let bag = await service.operate(store, {}, "sync"); const identity = { guestToken: bag.guestToken };
  bag = await service.operate(store, identity, "update", { offerId, quantity: .5, cartKey: bag.cartKey, revision: bag.revision });
  assert.equal(bag.subtotal, 6.18);
  await assert.rejects(service.operate(store, identity, "update", { offerId, quantity: 1, revision: 0 }), { status: 409 });
  change({ price: 20, availableQuantity: .25 });
  bag = await service.operate(store, identity, "sync");
  assert.equal(bag.subtotal, 10); assert.equal(bag.hasIssues, true);
  change(null); bag = await service.operate(store, identity, "sync");
  assert.equal(bag.items[0].product, null);
  bag = await service.operate(store, identity, "update", { offerId, quantity: 0, cartKey: bag.cartKey, revision: bag.revision });
  assert.equal(bag.items.length, 0);
  await assert.rejects(service.operate(store, identity, "update", { offerId, quantity: 1, cartKey: "a".repeat(64), revision: bag.revision }), { status: 409 });
});
test("guest/customer merge is idempotent, survives reload and is tenant/store scoped", async () => {
  const { service } = setup();
  let guest = await service.operate(store, {}, "sync", { legacyItems: [{ offerId, quantity: .5 }] });
  const guestIdentity = { guestToken: guest.guestToken };
  const identity = { ...guestIdentity, sessionToken: "a".repeat(64) };
  let bag = await service.operate(store, identity, "sync");
  assert.equal(bag.mode, "customer"); assert.equal(bag.guestToken, null); assert.equal(bag.items[0].quantity, .5);
  bag = await service.operate(store, identity, "sync"); assert.equal(bag.items[0].quantity, .5);
  guest = await service.operate(store, guestIdentity, "sync"); assert.equal(guest.items.length, 0);
  const other = await service.operate({ ...store, storeId: createId() }, identity, "sync"); assert.equal(other.items.length, 0);
  const tenant = await service.operate({ ...store, tenantId: createId() }, guestIdentity, "sync"); assert.equal(tenant.items.length, 0);
  const loggedOut = await service.operate(store, {}, "sync"); assert.equal(loggedOut.items.length, 0);
});
test("cart route rejects spoofed price, duplicate imports, overprecision and malformed auth", async () => {
  const { service } = setup();
  const app = createApp({ storefrontCartService: service });
  const url = "/api/storefront/v1/HORNBOOK_RETAIL/stores/MAIN/cart";
  await request(app).post(`${url}/sync`).send({ legacyItems: [{ offerId, quantity: 1 }, { offerId, quantity: 2 }] }).expect(422);
  await request(app).put(url).send({ offerId, quantity: 1, revision: 1, price: 1 }).expect(422);
  await request(app).put(url).send({ offerId, quantity: .1234567, revision: 1 }).expect(422);
  await request(app).post(`${url}/sync`).set("Authorization", "Bearer admin-jwt").send({}).expect(401);
});
