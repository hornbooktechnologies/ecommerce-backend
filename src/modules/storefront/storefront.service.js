import { AppError } from "../../core/errors/app-error.js";
import * as defaultDao from "./storefront.dao.js";
import { listProductMediaDetails, listProductCustomFields } from "../catalog/catalog.dao.js";
import { publicHero } from "../homepage/homepage.service.js";
import { publicSections } from "../homepage/sections.service.js";
import { checkDeliveryAvailability } from "./delivery-availability.service.js";

export function createStorefrontService({ dao = defaultDao, media = listProductMediaDetails,
  customFields = listProductCustomFields, hero = publicHero, sections = publicSections, delivery = checkDeliveryAvailability } = {}) {
  async function resolve(input) {
    const scope = await dao.resolveStore(input);
    if (!scope) throw new AppError({ code: "STOREFRONT_NOT_FOUND", message: "This store is unavailable.", status: 404 });
    return scope;
  }
  return {
    async deliveryAvailability(input, { postalCode }) { return delivery({ ...await resolve(input), postalCode }); },
    async catalog(input, filters) { const scope = await resolve(input); return dao.listProducts({ scope, filters }); },
    async configuration(input) {
      const scope = await resolve(input);
      const [facets, homepageHero, homepageSections] = await Promise.all([dao.listFacets({ scope }), hero(scope), sections(scope)]);
      return { store: { name: scope.name, tenantName: scope.tenantName, code: scope.code, currency: scope.currency }, ...facets, hero: homepageHero, homepageSections };
    },
    async detail(input, slug) {
      const scope = await resolve(input); const product = await dao.findProduct({ scope, slug });
      if (!product) throw new AppError({ code: "PRODUCT_NOT_FOUND", message: "This product is unavailable.", status: 404 });
      const [variants, images, fields, reviews] = await Promise.all([
        dao.listVariants({ scope, productId: product.id }),
        media({ tenantId: scope.tenantId, productId: product.id }),
        customFields({ tenantId: scope.tenantId, productId: product.id }),
        dao.listReviews({ scope, productId: product.id })
      ]);
      // Display only explicitly selected public specifications. Demo aggregate ratings are not reviews.
      const allowed = new Set(["Material", "Fit", "Care", "Origin", "Connectivity", "Battery", "Charging", "Warranty",
        "Dimensions", "Assembly", "Skin type", "Routine", "Formulation", "Shelf life", "Activity", "Storage",
        "Pack", "Diet", "Returns", "Age", "Safety", "Pieces", "Format", "Language", "Genre", "Publisher"]);
      const specifications = Object.fromEntries(fields.filter((field) => allowed.has(field.label))
        .map((field) => [field.label, String(field.value)]));
      const variantIds = new Set(variants.map((variant) => variant.id));
      const colorIds = new Set(variants.map((variant) => variant.colorId).filter(Boolean));
      return { ...product, variants, specifications, reviewsList: reviews,
        images: images.filter((item) => (!item.variantId || variantIds.has(item.variantId))
          && (!item.colorOptionId || colorIds.has(item.colorOptionId)))
          .map((item) => ({ id: item.id, url: item.url, alt: item.altText || product.name,
            variantId: item.variantId, colorId: item.colorOptionId, role: item.role, sortOrder: item.sortOrder })) };
    }
  };
}
