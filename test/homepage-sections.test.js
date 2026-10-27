import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";
import { defaultSections, createSectionsService, publicSections, renderSections } from "../src/modules/homepage/sections.service.js";
import { sectionsDocumentSchema } from "../src/modules/homepage/sections.validators.js";
import { read } from "../src/modules/homepage/sections.dao.js";
import { listProducts } from "../src/modules/storefront/storefront.dao.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const storeId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const scope = { tenantId, storeId, currency: "INR" };
test("section schema requires four unique sections, safe links and bounded product selections", () => {
  assert.ifError(sectionsDocumentSchema.validate(defaultSections()).error);
  for (const change of [
    (value) => value.sections.pop(),
    (value) => { value.sections[3] = value.sections[0]; },
    (value) => { value.sections[0].limit = 13; },
    (value) => { value.sections[0].productSlugs = ["same", "same"]; },
    (value) => { value.sections[1].href = "//evil.test"; },
    (value) => { value.sections[1].imageUrl = "javascript:alert(1)"; },
    (value) => { value.sections[0].rule = "cost_price"; }
  ]) { const value = defaultSections(); change(value); assert.ok(sectionsDocumentSchema.validate(value).error); }
});
test("automatic collections query full tenant/store catalog with explicit rules and limits", async () => {
  const calls = [];
  const result = await renderSections(scope, defaultSections(), { catalogDao: {
    listProducts: async (input) => { calls.push(input); return { items: [{ id: input.filters.sort }] }; }
  } });
  assert.deepEqual(result.sections.map((section) => section.key), ["DEALS", "DISCOVER", "FRESH"]);
  assert.deepEqual(calls.map((input) => input.filters.sort), ["discount", "review_count", "newest"]);
  assert.ok(calls[0].filters.minDiscount > 0);
  for (const call of calls) { assert.deepEqual(call.scope, scope); assert.equal(call.filters.pageSize, 6); }
});
test("manual order, limit and current visibility survive publication; drafts never leak", async () => {
  const document = defaultSections();
  document.sections.forEach((section) => { section.enabled = false; });
  document.sections[0] = { ...document.sections[0], enabled: true, rule: "MANUAL", productSlugs: ["second", "hidden", "first"], limit: 2 };
  const catalogDao = { findProduct: async ({ slug }) => slug === "hidden" ? null : { id: slug, price: 123 } };
  assert.equal(await publicSections(scope, { dao: { read: async () => ({ draft: document, published: null }) } }), null);
  const result = await publicSections(scope, { dao: { read: async () => ({ published: document }) }, catalogDao });
  assert.deepEqual(result.sections[0].items.map((product) => product.id), ["second", "first"]);
  assert.equal(result.sections[0].items[0].price, 123);
  document.sections[0].enabled = false;
  assert.deepEqual((await renderSections(scope, document, { catalogDao })).sections, []);
});
function fixture({ exists = true, owned = true, visible = true } = {}) {
  let current = null; const audit = [];
  const service = createSectionsService({ transaction: async (tenant, fn) => { assert.equal(tenant, tenantId); return fn({}); },
    storeDao: { findStore: async (input) => { assert.equal(input.tenantId, tenantId); assert.equal(input.storeId, storeId); return exists ? { baseCurrency: "INR" } : null; },
      insertAudit: async (input) => audit.push(input.audit.action) },
    assetDao: { ownsAsset: async () => owned },
    dao: { read: async () => current,
      saveDraft: async ({ document }) => { current = { draft: document, published: current?.published || null, revision: (current?.revision || 0) + 1 }; },
      publish: async () => { current = { ...current, published: current.draft, revision: current.revision + 1 }; } },
    catalogDao: { findProduct: async () => visible ? { id: "product" } : null, listFacets: async () => ({ categories: [] }) }
  });
  return { service, audit };
}
test("draft/publish is revision-checked, store-scoped and audited", async () => {
  const { service, audit } = fixture();
  const saved = await service.save(tenantId, storeId, { revision: 0, document: defaultSections() }, {});
  assert.equal(saved.published, null);
  await assert.rejects(() => service.save(tenantId, storeId, { revision: 0, document: defaultSections() }, {}), (error) => error.status === 409);
  const published = await service.save(tenantId, storeId, { revision: 1 }, {}, true);
  assert.deepEqual(published.published, defaultSections());
  assert.deepEqual(audit, ["HOMEPAGE_SECTIONS_DRAFT_SAVED", "HOMEPAGE_SECTIONS_PUBLISHED"]);
  await assert.rejects(() => fixture({ exists: false }).service.get(tenantId, storeId), (error) => error.status === 404);
});
test("foreign images, incomplete banners and unavailable manual products are rejected", async () => {
  const foreign = defaultSections(); foreign.sections[1].imageUrl = "https://other-store.test/banner.jpg";
  await assert.rejects(() => fixture({ owned: false }).service.save(tenantId, storeId, { revision: 0, document: foreign }, {}), (error) => error.code === "SECTION_IMAGE_INVALID");
  const incomplete = defaultSections(); incomplete.sections[1].enabled = true;
  const { service } = fixture(); await service.save(tenantId, storeId, { revision: 0, document: incomplete }, {});
  await assert.rejects(() => service.save(tenantId, storeId, { revision: 1 }, {}, true), (error) => error.code === "SECTION_IMAGE_REQUIRED" && error.details[0].field === "sections.1.imageUrl");
  const manual = defaultSections(); manual.sections[0].rule = "MANUAL"; manual.sections[0].productSlugs = ["private"];
  const unavailable = fixture({ visible: false }).service;
  await unavailable.save(tenantId, storeId, { revision: 0, document: manual }, {});
  await assert.rejects(() => unavailable.save(tenantId, storeId, { revision: 1 }, {}, true), (error) => error.code === "SECTION_PRODUCT_UNAVAILABLE");
});
test("sections DAO and collection sort SQL preserve tenant/store restrictions", async () => {
  await read({ ...scope, connection: { execute: async (sql, params) => { assert.match(sql, /tenant_id = \? AND store_id = \?/); assert.equal(params.length, 2); return [[]]; } } });
  for (const sort of ["discount", "review_count"]) {
    const sqlCalls = [];
    await listProducts({ scope, filters: { page: 1, pageSize: 6, sort }, connection: { query: async (sql) => {
      sqlCalls.push(sql); return sql.includes("SELECT COUNT(*) AS total FROM catalog") ? [[{ total: 0 }]] : [[]];
    } } });
    assert.ok(sqlCalls[0].includes(sort === "discount" ? "NULLIF(list_price, 0) DESC" : "ORDER BY review_count DESC"));
    assert.ok(sqlCalls[0].includes("so.tenant_id = ? AND so.store_id = ?"));
  }
});
test("section routes protect reads and writes and reject malformed input", async () => {
  const token = createAccessToken({ userId: tenantId, sessionId: storeId });
  const base = `/api/admin/v1/stores/${storeId}/homepage-sections`;
  const app = createApp({ homepageSectionsService: { get: async () => ({ draft: defaultSections() }), save: async () => ({ revision: 1 }) },
    tenantAccessResolver(req, _res, next) { req.context = { ...req.context, tenant: { tenantId, assignments: [{ scopeType: "TENANT", permissions: ["settings.store.read"] }] } }; next(); } });
  assert.equal((await request(app).get(base)).status, 401);
  assert.equal((await request(app).get(base).auth(token, { type: "bearer" })).status, 200);
  assert.equal((await request(app).post(`${base}/publish`).auth(token, { type: "bearer" }).send({ revision: 1 })).status, 403);
  assert.equal((await request(app).post(`${base}/preview`).auth(token, { type: "bearer" }).send({ sections: [] })).status, 422);
});
