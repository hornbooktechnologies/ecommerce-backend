import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./sections.dao.js";
import * as assets from "./homepage.dao.js";
import * as stores from "../store-operations/store-operations.dao.js";
import * as catalog from "../storefront/storefront.dao.js";
import {collectionScope,collectionChoices} from './sections-scope.dao.js';
import * as collections from './collections.dao.js';
import {renderCollection,collectionForLink} from './collections.service.js';

export function sectionActiveAt(section,at=Date.now()){
  const start=section.startsAt?Date.parse(section.startsAt):-Infinity,end=section.endsAt?Date.parse(section.endsAt):Infinity;
  return section.enabled&&Number.isFinite(Number(at))&&!Number.isNaN(start)&&!Number.isNaN(end)&&Number(at)>=start&&Number(at)<end;
}

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

export async function renderSections(scope, document, { catalogDao = catalog, connection,preview=false,at=Date.now() } = {}) {
  const sections = [];
  for (const section of document.sections.filter((item) => item.enabled)) {
    if(!preview&&!sectionActiveAt(section,at))continue;
    if (section.key === "BANNER") {
      if (!section.imageUrl || !section.title) continue;
      if(!preview&&!await collectionForLink(scope,section.href,{connection,live:true}))continue;
      sections.push({ ...section }); continue;
    }
    if(section.collectionId){
      const row=await collections.find({...scope,collectionId:section.collectionId,connection});
      const rendered=await renderCollection(scope,preview&&row?{...row,draft:row.published}:row,{page:1,pageSize:section.limit},connection,{preview});
      if(rendered?.items.length)sections.push({key:section.key,title:section.title||rendered.title,subtitle:section.subtitle,collectionSlug:rendered.slug,viewAllHref:section.viewAllHref?`/collections/${rendered.slug}`:'',viewAllLabel:section.viewAllLabel,items:rendered.items});
      continue;
    }
    const scopeFilters=await collectionScope({...scope,section,connection});if(!scopeFilters)continue;
    let items;
    if (section.rule === "MANUAL") {
      const selected=await catalogDao.listProducts({scope,connection,filters:{...scopeFilters,productSlugs:section.productSlugs,page:1,pageSize:12,sort:'featured'}});
      const bySlug=new Map(selected.items.map(item=>[item.slug,item]));items=section.productSlugs.map(slug=>bySlug.get(slug)).filter(Boolean).slice(0,section.limit);
    } else {
      const result = await catalogDao.listProducts({ scope, connection, filters: {
        ...scopeFilters,
        page: 1, pageSize: section.limit,
        sort: { DISCOUNT: "discount", REVIEWS: "review_count", NEWEST: "newest" }[section.rule],
        ...(section.rule === "DISCOUNT" ? { minDiscount: 0.000001 } : {})
      } });
      items = result.items;
    }
    if (items.length) sections.push({ key: section.key, title: section.title, subtitle: section.subtitle,
      viewAllHref: section.viewAllHref?.startsWith('/collections/')?await collectionForLink(scope,section.viewAllHref,{connection,live:true})?section.viewAllHref:'':section.viewAllHref&&(section.brandId||section.categoryId||(section.viewAllHref==='/products'&&section.inStockOnly))?`/products?${new URLSearchParams({...(scopeFilters.brand?{brands:scopeFilters.brand}:{}),...(scopeFilters.category?{category:scopeFilters.category}:{}),...(scopeFilters.inStock?{inStock:'true'}:{})})}`:section.viewAllHref, viewAllLabel: section.viewAllLabel, items });
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
      if(section.collectionId){const linked=await collections.find({...scope,collectionId:section.collectionId,connection});if(!linked||!linked.visible||!linked.published)fail('SECTION_COLLECTION_INVALID','Choose a published reusable collection from this store.',422,field('collectionId'));}
      if(section.key!=='BANNER'&&!section.collectionId&&!await collectionScope({...scope,section,connection}))fail('SECTION_SCOPE_INVALID','Choose active brand/category values from this tenant.',422,field('brandId'));
      if (section.key === "BANNER" && section.imageUrl && !await assetDao.ownsAsset({ ...scope, url: section.imageUrl, connection })) {
        fail("SECTION_IMAGE_INVALID", "Upload a banner image for this store.", 422, field("imageUrl"));
      }
      if (!publishing || !section.enabled) continue;
      if (!section.title) fail("SECTION_TITLE_REQUIRED", "Enter a title for each enabled section.", 422, field("title"));
      if (section.key === "BANNER") {
        if (!section.imageUrl) fail("SECTION_IMAGE_REQUIRED", "Upload a campaign image before enabling the banner.", 422, field("imageUrl"));
        if (!section.altText) fail("SECTION_ALT_REQUIRED", "Describe the banner image for screen readers.", 422, field("altText"));
        if (!section.ctaLabel) fail("SECTION_CTA_REQUIRED", "Enter the banner button label.", 422, field("ctaLabel"));
      } else if (!section.collectionId&&section.rule === "MANUAL") {
        if (!section.productSlugs.length) fail("SECTION_PRODUCTS_REQUIRED", "Select products for the manual collection.", 422, field("productSlugs"));
        for (const slug of section.productSlugs) {
          if (!await catalogDao.findProduct({ scope, slug, connection })) {
            fail("SECTION_PRODUCT_UNAVAILABLE", `The selected product ${slug} is no longer available in this store. Remove or replace it.`, 422, field("productSlugs"));
          }
        }
      }
      const href = section.key === "BANNER" ? section.href : section.viewAllHref;
      if(!section.collectionId&&!await collectionForLink(scope,href,{connection}))fail('SECTION_COLLECTION_INVALID','Choose a published reusable collection from this store.',422,field('viewAllHref'));
      const hrefField = field(section.key === "BANNER" ? "href" : "viewAllHref");
      const scopedCollection=section.key!=='BANNER'&&(section.brandId||section.categoryId);
      if (!scopedCollection&&href?.startsWith("/p/") && !await catalogDao.findProduct({ scope, slug: href.slice(3), connection })) {
        fail("SECTION_LINK_INVALID", "Choose a published product destination in this store.", 422, hrefField);
      }
      if (!scopedCollection&&href?.startsWith("/c/")) {
        const { categories } = await catalogDao.listFacets({ scope, connection });
        if (!categories.some((category) => `/c/${category.slug}` === href)) fail("SECTION_LINK_INVALID", "Choose an available category destination.", 422, hrefField);
      }
      if (section.key !== "BANNER" && href && !section.viewAllLabel) fail("SECTION_CTA_REQUIRED", "Enter a View all label or remove its link.", 422, field("viewAllLabel"));
    }
  }
  return {
    async scopes(tenantId,storeId,query){await resolve(tenantId,storeId);return collectionChoices({tenantId,...query});},
    async get(tenantId, storeId) {
      await resolve(tenantId, storeId);
      return await dao.read({ tenantId, storeId }) || { draft: defaultSections(), published: null, revision: 0, publishedAt: null };
    },
    async preview(tenantId, storeId, document) {
      const scope = await resolve(tenantId, storeId);
      await validate(scope, document, undefined, false);
      return renderSections(scope, document, { catalogDao,preview:true });
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
