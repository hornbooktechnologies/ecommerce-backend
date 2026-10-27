import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";
import { createHomepageService, publicHero, emptyHero } from "../src/modules/homepage/homepage.service.js";
import { saveHeroSchema } from "../src/modules/homepage/homepage.validators.js";
import { readHero } from "../src/modules/homepage/homepage.dao.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const storeId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const slide = { id: "018f47f2-6b6d-7c34-ae31-8f4f17b79b66", enabled: true, eyebrow: "New",
  title: "Summer collection", description: "Discover", productSlug: "shirt", imageUrl: "", altText: "",
  href: "/p/shirt", ctaLabel: "Shop now", tone: "sage", showPrice: true };
const document = { ...emptyHero(), slides: [slide] };
const scope = { tenantId, storeId, currency: "INR" };

test("hero validates slide limits, duplicate IDs, destinations, image schemes and timing", () => {
  assert.ifError(saveHeroSchema.validate({ revision: 0, document }).error);
  const invalid = [
    { ...document, intervalSeconds: 0 }, { ...document, slides: Array(11).fill(slide) },
    { ...document, slides: [slide, slide] },
    ...["javascript:alert(1)", "//evil.example", "/\\evil", "https://evil.example", "/c/../admin"].map((href) => ({ ...document, slides: [{ ...slide, href }] })),
    { ...document, slides: [{ ...slide, imageUrl: "data:image/svg+xml,test" }] }
  ];
  for (const value of invalid) assert.ok(saveHeroSchema.validate({ revision: 0, document: value }).error);
});
test("public hero excludes drafts and disabled slides, preserves order and checks linked product visibility", async () => {
  const unpublished = await publicHero(scope, { dao: { readHero: async () => ({ draft: document, published: null }) } });
  assert.equal(unpublished, null);
  const result = await publicHero(scope, {
    dao: { readHero: async () => ({ published: { ...document, slides: [
      { ...slide, id: "hidden", productSlug: "private" }, { ...slide, id: "off", enabled: false }, slide,
      { ...slide, id: "campaign", productSlug: "", href: "/", imageUrl: "https://example.com/image.jpg" }
    ] } }) },
    catalogDao: { findProduct: async ({ scope: received, slug }) => {
      assert.deepEqual(received, scope);
      return slug === "private" ? null : { name: "Shirt", slug, price: 799, mrp: 999, inStock: false, cost: "secret" };
    } }
  });
  assert.deepEqual(result.slides.map((item) => item.id), [slide.id, "campaign"]);
  assert.equal(result.slides[0].product.price, 799);
  assert.equal(result.slides[0].product.inStock, false);
  assert.equal(result.slides[0].href, "/p/shirt");
  assert.ok(!JSON.stringify(result).includes("secret"));
  const disabled = await publicHero(scope, { dao: { readHero: async () => ({ published: { ...document, enabled: false } }) } });
  assert.deepEqual(disabled.slides, []);
});

function fixture({ exists = true, owned = true, product = { name: "Shirt", image: "https://example.com/shirt.jpg" } } = {}) {
  let row = null; const audits = [];
  const service = createHomepageService({
    transaction: async (tenant, fn) => { assert.equal(tenant, tenantId); return fn({}); },
    storeDao: { findStore: async ({ tenantId: tenant, storeId: store }) => {
      assert.equal(tenant, tenantId); assert.equal(store, storeId);
      return exists ? { baseCurrency: "INR" } : null;
    }, insertAudit: async ({ audit }) => audits.push(audit.action) },
    dao: { readHero: async () => row, ownsAsset: async () => owned,
      saveDraft: async ({ document: draft }) => { row = { draft, revision: (row?.revision || 0) + 1, published: row?.published || null }; },
      publish: async () => { row = { ...row, published: row.draft, revision: row.revision + 1 }; }
    }, catalogDao: { findProduct: async () => product, listFacets: async () => ({ categories: [] }) }
  });
  return { service, audits };
}
test("save is draft-only, publish validates saved revision and writes audit events", async () => {
  const { service, audits } = fixture();
  const draft = await service.save(tenantId, storeId, { revision: 0, document }, {});
  assert.equal(draft.published, null);
  await assert.rejects(() => service.save(tenantId, storeId, { revision: 0, document }, {}), (error) => error.status === 409);
  const published = await service.save(tenantId, storeId, { revision: 1 }, {}, true);
  assert.deepEqual(published.published, document);
  assert.equal(published.revision, 2);
  assert.deepEqual(audits, ["HOMEPAGE_HERO_DRAFT_SAVED", "HOMEPAGE_HERO_PUBLISHED"]);
});
test("store isolation, image ownership, unpublished products and missing campaign content are enforced", async () => {
  await assert.rejects(() => fixture({ exists: false }).service.get(tenantId, storeId), (error) => error.status === 404);
  await assert.rejects(() => fixture({ owned: false }).service.save(tenantId, storeId, {
    revision: 0, document: { ...document, slides: [{ ...slide, imageUrl: "https://other-store/image.jpg" }] }
  }, {}), (error) => error.code === "HERO_IMAGE_INVALID");
  for (const [value, product, code] of [
    [document, null, "HERO_PRODUCT_UNAVAILABLE"],
    [{ ...document, slides: [] }, {}, "HERO_SLIDE_REQUIRED"],
    [{ ...document, slides: [{ ...slide, productSlug: "", title: "", href: "/" }] }, {}, "HERO_TITLE_REQUIRED"],
    [{ ...document, slides: [{ ...slide, productSlug: "", href: "/" }] }, {}, "HERO_IMAGE_REQUIRED"],
    [{ ...document, slides: [{ ...slide, imageUrl: "https://owned/image.jpg", altText: "" }] }, {}, "HERO_ALT_REQUIRED"]
  ]) {
    const { service } = fixture({ product });
    await service.save(tenantId, storeId, { revision: 0, document: value }, {});
    await assert.rejects(() => service.save(tenantId, storeId, { revision: 1 }, {}, true), (error) => error.code === code);
  }
});
test("hero DAO scopes reads by both tenant and store with parameterized SQL", async () => {
  await readHero({ ...scope, connection: { execute: async (sql, params) => {
    assert.match(sql, /tenant_id = \? AND store_id = \?/); assert.equal(params.length, 2); return [[]];
  } } });
});
test("admin routes require authentication, store permissions and valid input", async () => {
  const base = `/api/admin/v1/stores/${storeId}/homepage-hero`;
  const token = createAccessToken({ userId: tenantId, sessionId: storeId });
  const permissions = [];
  const app = createApp({ homepageService: { get: async (tenant, store) => {
    assert.equal(tenant, tenantId); assert.equal(store, storeId); return { draft: document };
  }, save: async () => ({ revision: 1 }) },
  tenantAccessResolver(req, _res, next) { req.context = { ...req.context, tenant: { tenantId } }; next(); },
  tenantPermissionAuthorization(permission) { return (_req, _res, next) => { permissions.push(permission); next(); }; }
  });
  assert.equal((await request(app).get(base)).status, 401);
  assert.equal((await request(app).get(base).auth(token, { type: "bearer" })).status, 200);
  assert.equal((await request(app).put(base).auth(token, { type: "bearer" }).send({ revision: 0, document })).status, 200);
  assert.equal((await request(app).put(base).auth(token, { type: "bearer" }).send({})).status, 422);
  assert.ok(permissions.includes("settings.store.read")); assert.ok(permissions.includes("settings.store.manage"));
});

test("read-only and vendor-scoped roles cannot publish or upload hero content", async () => {
  const token = createAccessToken({ userId: tenantId, sessionId: storeId });
  for (const scopeType of ["TENANT", "MERCHANT"]) {
    const app = createApp({ homepageService: { save() { assert.fail("Must not call service"); }, upload() { assert.fail("Must not store files"); } },
      tenantAccessResolver(req, _res, next) {
        req.context = { ...req.context, tenant: { tenantId, assignments: [{ scopeType,
          permissions: scopeType === "TENANT" ? ["settings.store.read"] : ["settings.store.read", "settings.store.manage"] }] } }; next();
      }
    });
    for (const path of ["publish", "images"]) {
      const response = await request(app).post(`/api/admin/v1/stores/${storeId}/homepage-hero/${path}`).auth(token, { type: "bearer" }).send({ revision: 1 });
      assert.equal(response.status, 403);
    }
  }
});
test("failed upload registration removes the new file and foreign stores cannot upload", async () => {
  let removed = false;
  const service = createHomepageService({
    storeDao: { findStore: async () => ({ baseCurrency: "INR" }) },
    storage: { store: async () => ({ url: "https://local/new-image.png" }), remove: async () => { removed = true; } },
    dao: { insertAsset: async () => { throw new Error("write failed"); } }
  });
  await assert.rejects(() => service.upload(tenantId, storeId, {}), /write failed/);
  assert.equal(removed, true);
  const denied = createHomepageService({ storeDao: { findStore: async () => null },
    storage: { store() { assert.fail("Must not store foreign uploads"); } } });
  await assert.rejects(() => denied.upload(tenantId, storeId, {}), (error) => error.status === 404);
});
