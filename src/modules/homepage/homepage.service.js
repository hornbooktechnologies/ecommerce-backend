import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./homepage.dao.js";
import * as stores from "../store-operations/store-operations.dao.js";
import * as catalog from "../storefront/storefront.dao.js";
import { productMediaStorage } from "../catalog/product-media-storage.js";

export const emptyHero = () => ({ enabled: true, autoplay: true, intervalSeconds: 6, slides: [] });
const fail = (code, message, status = 422) => { throw new AppError({ code, message, status }); };

export function createHomepageService({ dao = defaultDao, storeDao = stores, catalogDao = catalog,
  storage = productMediaStorage, transaction = withTransaction } = {}) {
  async function storeScope(tenantId, storeId, connection, lock = false) {
    const store = await storeDao.findStore({ tenantId, storeId, connection, forUpdate: lock });
    if (!store) fail("STORE_NOT_FOUND", "Store was not found.", 404);
    return { tenantId, storeId, currency: store.baseCurrency };
  }
  async function validateContent(scope, document, connection, publishing) {
    if (publishing && document.enabled && !document.slides.some((slide) => slide.enabled)) {
      fail("HERO_SLIDE_REQUIRED", "Add an enabled slide or turn off the hero before publishing.");
    }
    for (const [index, slide] of document.slides.entries()) {
      if (slide.imageUrl && !await dao.ownsAsset({ ...scope, url: slide.imageUrl, connection })) {
        fail("HERO_IMAGE_INVALID", `Slide ${index + 1}: upload an image for this store.`);
      }
      if (!publishing || !document.enabled || !slide.enabled) continue;
      const product = slide.productSlug ? await catalogDao.findProduct({ scope, slug: slide.productSlug, connection }) : null;
      if (slide.productSlug && !product) fail("HERO_PRODUCT_UNAVAILABLE", `Slide ${index + 1}: choose a published product with an active offer in this store.`);
      if (!slide.title && !product) fail("HERO_TITLE_REQUIRED", `Slide ${index + 1}: enter a headline.`);
      if (!slide.imageUrl && !product?.image) fail("HERO_IMAGE_REQUIRED", `Slide ${index + 1}: upload an image.`);
      if (slide.imageUrl && !slide.altText) fail("HERO_ALT_REQUIRED", `Slide ${index + 1}: describe the uploaded image for accessibility.`);
      if (!slide.productSlug && slide.href.startsWith("/p/")) {
        fail("HERO_PRODUCT_LINK_REQUIRED", `Slide ${index + 1}: select the product instead of entering a product URL.`);
      }
      if (!slide.productSlug && slide.href.startsWith("/c/")) {
        const { categories } = await catalogDao.listFacets({ scope, connection });
        if (!categories.some((category) => `/c/${category.slug}` === slide.href)) {
          fail("HERO_CATEGORY_UNAVAILABLE", `Slide ${index + 1}: choose an available category link.`);
        }
      }
    }
  }
  async function audit(scope, context, action, connection) {
    await storeDao.insertAudit({ audit: { id: createId(), ...scope, actorUserId: context.actorUserId,
      action, entityType: "STORE_HOMEPAGE", entityId: scope.storeId, requestId: context.requestId,
      ipAddress: context.ipAddress || "127.0.0.1", userAgent: context.userAgent || null,
      afterData: { storeId: scope.storeId } }, connection });
  }
  return {
    async get(tenantId, storeId) {
      await storeScope(tenantId, storeId);
      return await dao.readHero({ tenantId, storeId }) || { draft: emptyHero(), published: null, revision: 0, publishedAt: null };
    },
    async products(tenantId, storeId, search, selectedSlug = "") {
      const scope = await storeScope(tenantId, storeId);
      const [result, selectedProduct] = await Promise.all([
        catalogDao.listProducts({ scope, filters: { search, page: 1, pageSize: 20, sort: "featured" } }),
        selectedSlug ? catalogDao.findProduct({ scope, slug: selectedSlug }) : null
      ]);
      return { ...result, selectedProduct };
    },
    async save(tenantId, storeId, input, context, publishing = false) {
      return transaction(tenantId, async (connection) => {
        // Lock the store even before a hero row exists: prevents concurrent first-save races.
        const scope = await storeScope(tenantId, storeId, connection, true);
        const current = await dao.readHero({ ...scope, connection });
        if ((current?.revision || 0) !== input.revision) fail("HERO_REVISION_CONFLICT", "Another user changed this hero. Reload before saving.", 409);
        if (publishing && !current) fail("HERO_DRAFT_REQUIRED", "Save a draft before publishing.");
        const document = publishing ? current.draft : input.document;
        await validateContent(scope, document, connection, publishing);
        if (publishing) await dao.publish({ ...scope, connection });
        else await dao.saveDraft({ ...scope, document, connection });
        await audit(scope, context, publishing ? "HOMEPAGE_HERO_PUBLISHED" : "HOMEPAGE_HERO_DRAFT_SAVED", connection);
        return dao.readHero({ ...scope, connection });
      });
    },
    async upload(tenantId, storeId, file) {
      await storeScope(tenantId, storeId);
      const asset = await storage.store(file);
      try { await dao.insertAsset({ id: createId(), tenantId, storeId, ...asset }); }
      catch (error) { await storage.remove(asset.url); throw error; }
      return { url: asset.url };
    }
  };
}

// Only published content is public. Resolve linked products afresh, never snapshot prices/stock.
export async function publicHero(scope, { dao = defaultDao, catalogDao = catalog } = {}) {
  const row = await dao.readHero(scope);
  if (!row?.published) return null;
  const { enabled, autoplay, intervalSeconds, slides } = row.published;
  if (!enabled) return { enabled: false, autoplay, intervalSeconds, slides: [] };
  const visible = await Promise.all(slides.filter((slide) => slide.enabled).map(async (slide) => {
    const product = slide.productSlug ? await catalogDao.findProduct({ scope, slug: slide.productSlug }) : null;
    if (slide.productSlug && !product) return null;
    return { id: slide.id, eyebrow: slide.eyebrow, title: slide.title || product?.name,
      description: slide.description || product?.description || "", imageUrl: slide.imageUrl || product?.image,
      altText: slide.altText || product?.name || slide.title,
      href: product ? `/p/${product.slug}` : slide.href, ctaLabel: slide.ctaLabel, tone: slide.tone,
      product: product ? { name: product.name, brand: product.brand, price: product.price, mrp: product.mrp,
        inStock: product.inStock } : null, showPrice: slide.showPrice };
  }));
  return { enabled, autoplay, intervalSeconds, slides: visible.filter(Boolean) };
}
