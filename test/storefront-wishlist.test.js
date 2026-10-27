import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createId, uuidToBuffer } from "../src/core/identifiers/uuid.js";
import { digest } from "../src/modules/customer-accounts/customer-accounts.service.js";
import { createStorefrontWishlistService } from "../src/modules/storefront-wishlist/storefront-wishlist.service.js";
import * as wishlistDao from "../src/modules/storefront-wishlist/storefront-wishlist.dao.js";
import { wishlistProducts } from "../src/modules/storefront/storefront.dao.js";

function setup() {
  const store = { tenantId: createId(), storeId: createId(), currency: "INR" }, customerId = createId();
  const product = { id: createId(), name: "Published product", price: 149 }, second = { id: createId(), name: "Second product", price: 299 };
  const visible = new Map([[product.id, product], [second.id, second]]), rows = new Map();
  const key = (s) => `${s.tenantId}:${s.storeId}:${s.ownerHash.toString("hex")}`;
  const token = "a".repeat(64);
  const service = createStorefrontWishlistService({ storeResolver: async () => store,
    transaction: async (_id, fn) => { const before = structuredClone(rows); try { return await fn({}); } catch (error) { rows.clear(); for (const [k, value] of before) rows.set(k, value); throw error; } },
    accountDao: { limit: async () => true, findAccount: async () => ({}), session: async ({ tenantId, tokenHash }) => tenantId === store.tenantId && tokenHash.equals(digest(token)) ? { customerId, status: "ACTIVE" } : null },
    products: async ({ scope, productIds }) => scope.tenantId === store.tenantId && scope.storeId === store.storeId ? productIds.map((id) => visible.get(id)).filter(Boolean) : [],
    dao: {
      ensure: async (s) => { if (!rows.has(key(s))) rows.set(key(s), { productIds: [], revision: 0, legacyImported: false }); },
      read: async (s) => rows.has(key(s)) ? structuredClone(rows.get(key(s))) : null,
      save: async (s) => rows.set(key(s), { ...rows.get(key(s)), productIds: [...s.productIds], legacyImported: s.legacyImported, revision: rows.get(key(s)).revision + 1 }),
      consume: async (s) => rows.set(key(s), { ...rows.get(key(s)), productIds: [], consumed: true })
    } });
  const sync = (identity = {}, legacyProductIds = []) => service.operate(store, identity, "sync", { legacyProductIds });
  const update = (identity, list, productId, saved) => service.operate(store, identity, "update", { productId, saved, listKey: list.listKey, revision: list.revision });
  return { service, store, customerId, token, product, second, visible, rows, sync, update };
}

test("guest merge is deduplicated and consumed tokens cannot replay removed products", async () => {
  const s = setup(); const guest = await s.sync({}, [s.product.id]);
  const identity = { sessionToken: s.token, guestToken: guest.guestToken };
  const merged = await s.sync(identity);
  assert.equal(merged.mode, "customer"); assert.equal(merged.merged, true); assert.equal(merged.guestToken, null);
  assert.equal(merged.items.length, 1);
  const removed = await s.update(identity, merged, s.product.id, false);
  assert.equal(removed.items.length, 0);
  assert.equal((await s.sync(identity)).items.length, 0);
  await assert.rejects(s.sync({ guestToken: guest.guestToken }), { status: 410 });
});

test("wishlists are isolated by store/account and stale revisions cannot mutate", async () => {
  const s = setup(); const first = await s.sync({ sessionToken: s.token });
  const saved = await s.update({ sessionToken: s.token }, first, s.product.id, true);
  assert.equal((await s.sync({ sessionToken: s.token })).items[0].product.price, 149);
  assert.equal((await s.sync()).items.length, 0);
  await assert.rejects(s.update({ sessionToken: s.token }, first, s.second.id, true), { code: "WISHLIST_CHANGED" });
  await assert.rejects(s.update({}, saved, s.product.id, false), { status: 409 });
  const otherStore = await s.service.operate({ ...s.store, storeId: createId() }, { sessionToken: s.token }, "sync", { legacyProductIds: [] });
  assert.equal(otherStore.items.length, 0);
  await assert.rejects(s.service.operate({ ...s.store, tenantId: createId() }, { sessionToken: s.token }, "sync", { legacyProductIds: [] }), { status: 401 });
  for (const sessionToken of ["invalid", "b".repeat(64)]) await assert.rejects(s.sync({ sessionToken }), { status: 401 });
});

test("unpublished products expose no snapshots and remain removable; foreign additions fail", async () => {
  const s = setup(); const list = await s.sync({}, [s.product.id, createId()]);
  assert.equal(list.items.length, 1); s.visible.delete(s.product.id);
  const identity = { guestToken: list.guestToken }, current = await s.sync(identity);
  assert.deepEqual(current.items, [{ productId: s.product.id, product: null }]);
  const empty = await s.update(identity, current, s.product.id, false);
  assert.equal(empty.items.length, 0);
  await assert.rejects(s.update(identity, empty, s.product.id, true), { code: "PRODUCT_UNAVAILABLE" });
});

test("legacy imports happen once and the 100-product limit does not silently drop items", async () => {
  const s = setup(); const list = await s.sync({}, [s.product.id]); const identity = { guestToken: list.guestToken };
  const empty = await s.update(identity, list, s.product.id, false);
  assert.equal((await s.sync(identity, [s.product.id])).items.length, 0);
  const row = [...s.rows.values()][0]; row.productIds = Array.from({ length: 100 }, createId);
  await assert.rejects(s.update(identity, empty, s.second.id, true), { code: "WISHLIST_LIMIT" });
  assert.equal([...s.rows.values()][0].productIds.length, 100);
});

test("wishlist routes reject client identity, price and malformed payloads", async () => {
  const s = setup(), app = createApp({ storefrontWishlistService: s.service });
  const base = "/api/storefront/v1/SHOP/stores/MAIN/wishlist";
  const response = await request(app).post(`${base}/sync`).send({});
  assert.equal(response.status, 200); assert.equal(response.headers["cache-control"], "no-store");
  for (const body of [{ customerId: createId() }, { legacyProductIds: ["bad"] }, { legacyProductIds: Array(101).fill(s.product.id) }]) assert.equal((await request(app).post(`${base}/sync`).send(body)).status, 422);
  const data = response.body.data;
  assert.equal((await request(app).put(base).send({ productId: s.product.id, saved: true, listKey: data.listKey, revision: data.revision, price: 1 })).status, 422);
  assert.equal((await request(app).post(`${base}/sync`).set("Authorization", "Bearer malformed").send({})).status, 401);
});

test("wishlist DAO binds owner, tenant and store; live product queries reuse publication guards", async () => {
  const scope = { tenantId: createId(), storeId: createId(), ownerHash: digest("owner"), currency: "INR" }, productId = createId();
  const connection = { execute: async (sql, values) => {
    assert.match(sql, /tenant_id = \? AND store_id = \? AND owner_hash = \?/);
    assert.deepEqual(values, [uuidToBuffer(scope.tenantId), uuidToBuffer(scope.storeId), scope.ownerHash]); return [[]];
  }, query: async (sql, values) => {
    assert.ok(sql.includes("publication_status = 'PUBLISHED'")); assert.ok(sql.includes("approval_status = 'APPROVED'"));
    assert.match(sql, /WHERE id IN \(\?\)/); assert.deepEqual(values, ["INR", uuidToBuffer(scope.tenantId), uuidToBuffer(scope.storeId), uuidToBuffer(productId)]); return [[]];
  } };
  assert.equal(await wishlistDao.read({ ...scope, connection }), null);
  assert.deepEqual(await wishlistProducts({ scope, productIds: [productId], connection }), []);
});
