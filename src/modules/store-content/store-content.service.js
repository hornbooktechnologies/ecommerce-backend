import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import { resolveStore } from "../storefront/storefront.dao.js";
import * as defaultDao from "./store-content.dao.js";
import { documentSchema, pageDefinitions, validate } from "./store-content.validators.js";

const fail = (code, message, status) => { throw new AppError({ code, message, status }); };
const normalize = (document) => { const value = validate(documentSchema, document); return { title: value.title, summary: value.summary, body: value.body }; };
export const renderContent = (document) => ({ ...document, paragraphs: document.body.split(/\n\s*\n/).filter((paragraph) => paragraph.trim()) });
function definition(pageKey) {
  const page = pageDefinitions.find((item) => item.key === pageKey);
  if (!page) fail("CONTENT_PAGE_NOT_FOUND", "This store page was not found.", 404);
  return page;
}
function workspace(pageKey, row, store) {
  const page = definition(pageKey);
  return { page, store, draft: row?.draft || { title: page.label, summary: "", body: "" }, published: row?.published || null,
    revision: row?.revision || 0, publishedAt: row?.publishedAt || null, updatedAt: row?.updatedAt || null,
    hasUnpublishedChanges: Boolean(row && JSON.stringify(row.draft) !== JSON.stringify(row.published)) };
}
export function createStoreContentService({ dao = defaultDao, transaction = withTransaction, storeResolver = resolveStore } = {}) {
  async function storeScope(tenantId, storeId, connection, lock = false) {
    const store = await dao.findStore({ tenantId, storeId, connection, lock });
    if (!store) fail("STORE_NOT_FOUND", "Store was not found in this workspace.", 404);
    return store;
  }
  async function publicScope(params) {
    const store = await storeResolver(params);
    if (!store) fail("STOREFRONT_NOT_FOUND", "This store is unavailable.", 404);
    return store;
  }
  async function mutate(tenantId, storeId, pageKey, input, context, action) {
    definition(pageKey);
    if (action === "publish" && input.reviewed !== true) fail("CONTENT_REVIEW_REQUIRED", "Review and approve this content before publishing.", 422);
    if (action === "withdraw" && input.confirmed !== true) fail("CONTENT_CONFIRMATION_REQUIRED", "Confirm that this page should be removed from the storefront.", 422);
    const document = action === "save" ? normalize(input.document) : null;
    return transaction(tenantId, async (connection) => {
      // Store lock also serializes first saves, when a content row does not exist.
      const store = await storeScope(tenantId, storeId, connection, true);
      const scope = { tenantId, storeId, pageKey, connection };
      const current = await dao.read(scope);
      if ((current?.revision || 0) !== input.revision) fail("CONTENT_REVISION_CONFLICT",
        "Another request changed this page. Copy any unsaved text, then reload the saved version before trying again.", 409);
      const pageId = current?.id || createId();
      if (action === "save") await dao.save({ ...scope, pageId, document, exists: Boolean(current), actorUserId: context.actorUserId });
      else {
        if (!current) fail("CONTENT_DRAFT_REQUIRED", "Save a draft before publishing this page.", 409);
        if (action === "publish") {
          if (!current.draft.body.trim()) fail("CONTENT_BODY_REQUIRED", "Add approved page content before publishing.", 422);
          if (pageKey.startsWith("FAQ_") && current.draft.body.trim().split(/\n\s*\n/).some(block => !block.trim().includes("\n"))) {
            fail("FAQ_ANSWER_REQUIRED", "Give each question an answer on the next line. Leave a blank line between questions.", 422);
          }
          await dao.publish({ ...scope, actorUserId: context.actorUserId });
        } else {
          if (!current.published) return workspace(pageKey, current, store);
          await dao.withdraw({ ...scope, actorUserId: context.actorUserId });
        }
      }
      const next = await dao.read(scope);
      await dao.audit({ ...scope, pageId, action: `store.content.${{ save: "draft_saved", publish: "published", withdraw: "withdrawn" }[action]}`,
        revision: next.revision, context });
      return workspace(pageKey, next, store);
    });
  }
  return {
    async stores(tenantId, search) { return { ...await dao.listStores({ tenantId, search }), pages: pageDefinitions }; },
    async get(tenantId, storeId, pageKey) {
      definition(pageKey); const store = await storeScope(tenantId, storeId);
      return workspace(pageKey, await dao.read({ tenantId, storeId, pageKey }), store);
    },
    async preview(tenantId, storeId, pageKey, document) {
      definition(pageKey); await storeScope(tenantId, storeId);
      return { ...renderContent(normalize(document)), previewOnly: true };
    },
    save: (tenantId, storeId, pageKey, input, context) => mutate(tenantId, storeId, pageKey, input, context, "save"),
    publish: (tenantId, storeId, pageKey, input, context) => mutate(tenantId, storeId, pageKey, input, context, "publish"),
    withdraw: (tenantId, storeId, pageKey, input, context) => mutate(tenantId, storeId, pageKey, input, context, "withdraw"),
    async publicIndex(params) {
      const scope = await publicScope(params); const rows = await dao.publicIndex(scope);
      return { items: pageDefinitions.flatMap((page) => {
        const row = rows.find((item) => item.key === page.key);
        return row ? [{ key: page.key, slug: page.slug, title: row.title, path: `/pages/${page.slug}`, publishedAt: row.publishedAt }] : [];
      }) };
    },
    async publicPage(params, slug) {
      const page = pageDefinitions.find((item) => item.slug === slug);
      if (!page) fail("CONTENT_PAGE_NOT_FOUND", "This page is unavailable.", 404);
      const scope = await publicScope(params); const row = await dao.publicRead({ ...scope, pageKey: page.key });
      if (!row) fail("CONTENT_PAGE_NOT_FOUND", "This page is not published for this store.", 404);
      return { ...renderContent(row.document), slug: page.slug, publishedAt: row.publishedAt };
    }
  };
}
