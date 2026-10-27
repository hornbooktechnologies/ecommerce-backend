import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./sections.dao.js";
import * as assets from "./homepage.dao.js";
import * as stores from "../store-operations/store-operations.dao.js";
import * as catalog from "../storefront/storefront.dao.js";

export function defaultSections() {
  const shelf = (key, title, subtitle, rule) => ({ key, title, subtitle, rule, enabled: true,
    limit: 6, productSlugs: [], viewAllHref: "", viewAllLabel: "View all" });
  return { sections: [
    shelf("DEALS", "Blockbuster deals", "Prices drop. Excitement rises.", "DISCOUNT"),
    { key: "BANNER", title: "Quiet confidence. Standout style.", subtitle: "Discover your next everyday favourite.",
      enabled: false, imageUrl: "", altText: "", eyebrow: "THE STYLE EDIT", badgeText: "", href: "/", ctaLabel: "Explore the edit" },
    shelf("DISCOVER", "More to discover", "Explore the collection", "REVIEWS"),
    shelf("FRESH", "Fresh arrivals", "Just landed", "NEWEST")
  ] };
}

export async function renderSections(scope, document, { catalogDao = catalog, connection } = {}) {
  const sections = [];
  for (const section of document.sections.filter((item) => item.enabled)) {
    if (section.key === "BANNER") {
      if (!section.imageUrl || !section.title) continue;
      sections.push({ ...section }); continue;
    }
    let items;
    if (section.rule === "MANUAL") {
      const selected = await Promise.all(section.productSlugs.map((slug) => catalogDao.findProduct({ scope, slug, connection })));
      items = selected.filter(Boolean).slice(0, section.limit);
    } else {
      const result = await catalogDao.listProducts({ scope, connection, filters: {
        page: 1, pageSize: section.limit,
        sort: { DISCOUNT: "discount", REVIEWS: "review_count", NEWEST: "newest" }[section.rule],
        ...(section.rule === "DISCOUNT" ? { minDiscount: 0.000001 } : {})
      } });
      items = result.items;
    }
    if (items.length) sections.push({ key: section.key, title: section.title, subtitle: section.subtitle,
      viewAllHref: section.viewAllHref, viewAllLabel: section.viewAllLabel, items });
  }
  return { sections };
}

export async function publicSections(scope, { dao = defaultDao, catalogDao = catalog } = {}) {
  const row = await dao.read(scope);
  return row?.published ? renderSections(scope, row.published, { catalogDao }) : null;
}

export function createSectionsService({ dao = defaultDao, assetDao = assets, storeDao = stores,
  catalogDao = catalog, transaction = withTransaction } = {}) {
  const fail = (code, message, status = 422, field = "") => {
    throw new AppError({ code, message, status, details: field ? [{ field, message }] : [] });
  };
  async function resolve(tenantId, storeId, connection, forUpdate = false) {
    const store = await storeDao.findStore({ tenantId, storeId, connection, forUpdate });
    if (!store) fail("STORE_NOT_FOUND", "Store was not found.", 404);
    return { tenantId, storeId, currency: store.baseCurrency };
  }
  async function validate(scope, document, connection, publishing) {
    for (const [index, section] of document.sections.entries()) {
      const field = (name) => `sections.${index}.${name}`;
      if (section.key === "BANNER" && section.imageUrl && !await assetDao.ownsAsset({ ...scope, url: section.imageUrl, connection })) {
        fail("SECTION_IMAGE_INVALID", "Upload a banner image for this store.", 422, field("imageUrl"));
      }
      if (!publishing || !section.enabled) continue;
      if (!section.title) fail("SECTION_TITLE_REQUIRED", "Enter a title for each enabled section.", 422, field("title"));
      if (section.key === "BANNER") {
        if (!section.imageUrl) fail("SECTION_IMAGE_REQUIRED", "Upload a campaign image before enabling the banner.", 422, field("imageUrl"));
        if (!section.altText) fail("SECTION_ALT_REQUIRED", "Describe the banner image for screen readers.", 422, field("altText"));
        if (!section.ctaLabel) fail("SECTION_CTA_REQUIRED", "Enter the banner button label.", 422, field("ctaLabel"));
      } else if (section.rule === "MANUAL") {
        if (!section.productSlugs.length) fail("SECTION_PRODUCTS_REQUIRED", "Select products for the manual collection.", 422, field("productSlugs"));
        for (const slug of section.productSlugs) {
          if (!await catalogDao.findProduct({ scope, slug, connection })) {
            fail("SECTION_PRODUCT_UNAVAILABLE", `The selected product ${slug} is no longer available in this store. Remove or replace it.`, 422, field("productSlugs"));
          }
        }
      }
      const href = section.key === "BANNER" ? section.href : section.viewAllHref;
      const hrefField = field(section.key === "BANNER" ? "href" : "viewAllHref");
      if (href?.startsWith("/p/") && !await catalogDao.findProduct({ scope, slug: href.slice(3), connection })) {
        fail("SECTION_LINK_INVALID", "Choose a published product destination in this store.", 422, hrefField);
      }
      if (href?.startsWith("/c/")) {
        const { categories } = await catalogDao.listFacets({ scope, connection });
        if (!categories.some((category) => `/c/${category.slug}` === href)) fail("SECTION_LINK_INVALID", "Choose an available category destination.", 422, hrefField);
      }
      if (section.key !== "BANNER" && href && !section.viewAllLabel) fail("SECTION_CTA_REQUIRED", "Enter a View all label or remove its link.", 422, field("viewAllLabel"));
    }
  }
  return {
    async get(tenantId, storeId) {
      await resolve(tenantId, storeId);
      return await dao.read({ tenantId, storeId }) || { draft: defaultSections(), published: null, revision: 0, publishedAt: null };
    },
    async preview(tenantId, storeId, document) {
      const scope = await resolve(tenantId, storeId);
      await validate(scope, document, undefined, false);
      return renderSections(scope, document, { catalogDao });
    },
    async save(tenantId, storeId, input, context, publishing = false) {
      return transaction(tenantId, async (connection) => {
        const scope = await resolve(tenantId, storeId, connection, true);
        const current = await dao.read({ ...scope, connection });
        if ((current?.revision || 0) !== input.revision) fail("SECTIONS_REVISION_CONFLICT", "Another user changed these sections. Reload before saving.", 409);
        if (publishing && !current) fail("SECTIONS_DRAFT_REQUIRED", "Save a draft before publishing.");
        const document = publishing ? current.draft : input.document;
        await validate(scope, document, connection, publishing);
        if (publishing) await dao.publish({ ...scope, connection });
        else await dao.saveDraft({ ...scope, document, connection });
        await storeDao.insertAudit({ audit: { id: createId(), ...scope, actorUserId: context.actorUserId,
          action: publishing ? "HOMEPAGE_SECTIONS_PUBLISHED" : "HOMEPAGE_SECTIONS_DRAFT_SAVED",
          entityType: "STORE_HOMEPAGE", entityId: storeId, requestId: context.requestId,
          ipAddress: context.ipAddress || "127.0.0.1", userAgent: context.userAgent || null,
          afterData: { storeId, sectionOrder: document.sections.map((section) => section.key) } }, connection });
        return dao.read({ ...scope, connection });
      });
    }
  };
}
