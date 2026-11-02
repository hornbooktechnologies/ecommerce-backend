import assert from "node:assert/strict";
import test from "node:test";
import { createStoreContentService } from "../src/modules/store-content/store-content.service.js";
import { schemas, validate } from "../src/modules/store-content/store-content.validators.js";

const tenantId = "019a3000-1111-7111-8111-111111111111";
const storeId = "019a3000-2222-7222-8222-222222222222";
const context = { actorUserId: "019a3000-3333-7333-8333-333333333333", requestId: "content-fixture" };
const params = { tenantCode: "TEST", storeCode: "MAIN" };
const document = { title: "About this test store", summary: "Synthetic fixture, not client content.", body: "First test paragraph.\n\nSecond test paragraph." };
function fixture({ failAudit = false, inactive = false } = {}) {
  let row = null; const events = [];
  const matches = (scope) => scope.tenantId === tenantId && scope.storeId === storeId && scope.pageKey === "ABOUT";
  const dao = {
    async findStore(scope) { return scope.tenantId === tenantId && scope.storeId === storeId ? { id: storeId, name: "Test store", status: inactive ? "INACTIVE" : "ACTIVE" } : null; },
    async read(scope) { return matches(scope) && row ? structuredClone(row) : null; },
    async save(input) { assert.ok(matches(input)); row = { id: input.pageId, draft: structuredClone(input.document),
      published: row?.published || null, revision: (row?.revision || 0) + 1, publishedAt: row?.publishedAt || null }; },
    async publish(scope) { assert.ok(matches(scope)); row.published = structuredClone(row.draft); row.revision += 1; row.publishedAt = "2026-11-02T00:00:00.000Z"; },
    async withdraw(scope) { assert.ok(matches(scope)); row.published = null; row.revision += 1; row.publishedAt = null; },
    async audit(event) { if (failAudit) throw new Error("fixture audit failure"); events.push(event.action); },
    async publicIndex(scope) { assert.equal(scope.tenantId, tenantId); return row?.published ? [{ key: "ABOUT", title: row.published.title, publishedAt: row.publishedAt }] : []; },
    async publicRead(scope) { return matches(scope) && row?.published ? { document: structuredClone(row.published), publishedAt: row.publishedAt } : null; }
  };
  const service = createStoreContentService({ dao, transaction: async (_tenantId, operation) => {
    const before = structuredClone(row); const eventCount = events.length;
    try { return await operation({}); } catch (error) { row = before; events.length = eventCount; throw error; }
  }, storeResolver: async (input) => !inactive && input.tenantCode === params.tenantCode && input.storeCode === params.storeCode ? { tenantId, storeId } : null });
  return { service, row: () => row, events };
}

test("pages start empty; preview does not persist or publish content", async () => {
  const h = fixture(); const data = await h.service.get(tenantId, storeId, "ABOUT");
  assert.equal(data.revision, 0); assert.equal(data.draft.body, ""); assert.equal(data.published, null);
  const preview = await h.service.preview(tenantId, storeId, "ABOUT", document);
  assert.equal(preview.previewOnly, true); assert.deepEqual(preview.paragraphs, ["First test paragraph.", "Second test paragraph."]);
  assert.equal(h.row(), null); assert.equal(h.events.length, 0);
});
test("saved drafts are private; an explicit approved publish exposes only the public snapshot", async () => {
  const h = fixture(); const saved = await h.service.save(tenantId, storeId, "ABOUT", { revision: 0, document }, context);
  assert.deepEqual((await h.service.publicIndex(params)).items, []);
  await assert.rejects(h.service.publicPage(params, "about"), { code: "CONTENT_PAGE_NOT_FOUND" });
  await assert.rejects(h.service.publish(tenantId, storeId, "ABOUT", { revision: saved.revision }, context), { code: "CONTENT_REVIEW_REQUIRED" });
  await h.service.publish(tenantId, storeId, "ABOUT", { revision: saved.revision, reviewed: true }, context);
  const page = await h.service.publicPage(params, "about");
  assert.equal(page.body, document.body); assert.equal(Object.hasOwn(page, "draft"), false);
  assert.equal(Object.hasOwn(page, "revision"), false); assert.equal((await h.service.publicIndex(params)).items[0].path, "/pages/about");
});
test("editing a published page leaves its live snapshot unchanged; stale revisions cannot publish or overwrite", async () => {
  const h = fixture(); await h.service.save(tenantId, storeId, "ABOUT", { revision: 0, document }, context);
  const published = await h.service.publish(tenantId, storeId, "ABOUT", { revision: 1, reviewed: true }, context);
  const edited = await h.service.save(tenantId, storeId, "ABOUT", { revision: published.revision, document: { ...document, body: "Unpublished test change." } }, context);
  assert.equal(edited.hasUnpublishedChanges, true); assert.equal((await h.service.publicPage(params, "about")).body, document.body);
  await assert.rejects(h.service.save(tenantId, storeId, "ABOUT", { revision: published.revision, document }, context), { code: "CONTENT_REVISION_CONFLICT" });
  await assert.rejects(h.service.publish(tenantId, storeId, "ABOUT", { revision: published.revision, reviewed: true }, context), { code: "CONTENT_REVISION_CONFLICT" });
});
test("withdrawal removes public content and footer link but preserves the saved draft", async () => {
  const h = fixture(); await h.service.save(tenantId, storeId, "ABOUT", { revision: 0, document }, context);
  const published = await h.service.publish(tenantId, storeId, "ABOUT", { revision: 1, reviewed: true }, context);
  await assert.rejects(h.service.withdraw(tenantId, storeId, "ABOUT", { revision: published.revision }, context), { code: "CONTENT_CONFIRMATION_REQUIRED" });
  const withdrawn = await h.service.withdraw(tenantId, storeId, "ABOUT", { revision: published.revision, confirmed: true }, context);
  assert.equal(withdrawn.draft.body, document.body); assert.equal(withdrawn.published, null);
  assert.deepEqual((await h.service.publicIndex(params)).items, []);
  await assert.rejects(h.service.publicPage(params, "about"), { code: "CONTENT_PAGE_NOT_FOUND" });
});
test("empty policy drafts cannot publish, and audit failure rolls back a draft write", async () => {
  const h = fixture(); await h.service.save(tenantId, storeId, "ABOUT", { revision: 0, document: { ...document, body: "" } }, context);
  await assert.rejects(h.service.publish(tenantId, storeId, "ABOUT", { revision: 1, reviewed: true }, context), { code: "CONTENT_BODY_REQUIRED" });
  const broken = fixture({ failAudit: true });
  await assert.rejects(broken.service.save(tenantId, storeId, "ABOUT", { revision: 0, document }, context), /fixture audit failure/);
  assert.equal(broken.row(), null);
});
test("tenant, store and inactive-store boundaries apply to reads and writes", async () => {
  const h = fixture();
  await assert.rejects(h.service.get("other-tenant", storeId, "ABOUT"), { code: "STORE_NOT_FOUND" });
  await assert.rejects(h.service.save(tenantId, "other-store", "ABOUT", { revision: 0, document }, context), { code: "STORE_NOT_FOUND" });
  await assert.rejects(h.service.publicPage({ ...params, tenantCode: "OTHER" }, "about"), { code: "STOREFRONT_NOT_FOUND" });
  await assert.rejects(h.service.publicPage(params, "unknown"), { code: "CONTENT_PAGE_NOT_FOUND" });
  const inactive = fixture({ inactive: true });
  await inactive.service.save(tenantId, storeId, "ABOUT", { revision: 0, document }, context);
  await assert.rejects(inactive.service.publicIndex(params), { code: "STOREFRONT_NOT_FOUND" });
});
test("input validation bounds content and requires real boolean approval", () => {
  assert.throws(() => validate(schemas.publish, { revision: 1, reviewed: "true" }), { code: "VALIDATION_FAILED" });
  assert.throws(() => validate(schemas.save, { revision: 0, document: { ...document, body: "a".repeat(30001) } }), { code: "VALIDATION_FAILED" });
  assert.equal(validate(schemas.save, { revision: 0, document: { ...document, body: "One\r\n\r\nTwo" } }).document.body, "One\n\nTwo");
});
