import { AppError } from "../../core/errors/app-error.js";
import * as defaultDao from "./storefront.dao.js";
import { listProductMediaDetails, listProductCustomFields } from "../catalog/catalog.dao.js";
import { publicHero } from "../homepage/homepage.service.js";
import { publicSections } from "../homepage/sections.service.js";
import { checkDeliveryAvailability } from "./delivery-availability.service.js";
import { publicGuide } from "../size-guides/size-guides.dao.js";
import { publicSpecifications } from '../specifications/specifications.service.js';
import { resolveAppearance } from '../../config/appearance/appearance.js';

export function createStorefrontService({ dao = defaultDao, media = listProductMediaDetails,
  customFields = listProductCustomFields, hero = publicHero, sections = publicSections, delivery = checkDeliveryAvailability, guide = publicGuide, specs = publicSpecifications } = {}) {
  async function resolve(input) {
    const scope = await dao.resolveStore(input);
    if (!scope) throw new AppError({ code: "STOREFRONT_NOT_FOUND", message: "This store is unavailable.", status: 404 });
    return scope;
  }
  return {
    async deliveryAvailability(input, { postalCode }) { return delivery({ ...await resolve(input), postalCode }); },
    async catalog(input, filters) { const scope = await resolve(input); return dao.listProducts({ scope, filters }); },
    async facets(input, filters) { const scope = await resolve(input); return dao.listDiscoveryFacets({ scope, filters }); },
    async comparison(input, selections) {
      const scope = await resolve(input);
      const items = await Promise.all(selections.map(async selection => {
        const product = await dao.findProduct({ scope, slug: selection.slug });
        if (!product) throw new AppError({code:'COMPARISON_UNAVAILABLE',message:'A selected product is no longer available. Remove it and choose another.',status:404});
        const [variants, specifications, images] = await Promise.all([dao.listVariants({scope,productId:product.id}),specs({tenantId:scope.tenantId,productId:product.id}),media({tenantId:scope.tenantId,productId:product.id})]);
        const offer = variants.find(item=>item.offerId===(selection.offerId||product.offerId));
        if (!offer) throw new AppError({code:'COMPARISON_OFFER_UNAVAILABLE',message:'A selected seller offer is no longer available. Choose it again from the product page.',status:422});
        const image=images.filter(item=>(!item.variantId||item.variantId===offer.id)&&(!item.colorOptionId||item.colorOptionId===offer.colorId))
          .sort((a,b)=>Number(Boolean(b.variantId))-Number(Boolean(a.variantId))||Number(Boolean(b.colorOptionId))-Number(Boolean(a.colorOptionId))||Number(b.role==='PRIMARY')-Number(a.role==='PRIMARY')||a.sortOrder-b.sortOrder)[0]?.url||'';
        return {id:product.id,slug:product.slug,name:product.name,brand:product.brand,vertical:product.vertical,image,
          currency:product.currency,offerId:offer.offerId,price:offer.price,mrp:offer.mrp,includesTax:offer.includesTax,
          sellerName:offer.sellerName,variantName:offer.name,color:offer.color,size:offer.size,
          inStock:Math.min(offer.availableQuantity,offer.maximumOrderQuantity??offer.availableQuantity)>=offer.minimumOrderQuantity,availableQuantity:offer.availableQuantity,
          rating:product.rating,reviews:product.reviews,specifications};
      }));
      if(new Set(items.map(item=>item.id)).size!==items.length)throw new AppError({code:'COMPARISON_DUPLICATE',message:'Choose different products to compare.',status:422});
      if(new Set(items.map(item=>item.vertical)).size!==1)throw new AppError({code:'COMPARISON_TYPE',message:'Compare products of the same product type.',status:422});
      return {items};
    },
    async configuration(input) {
      const scope = await resolve(input);
      const [facets, homepageHero, homepageSections] = await Promise.all([dao.listFacets({ scope }), hero(scope), sections(scope)]);
      return { store: { name: scope.name, tenantName: scope.tenantName, code: scope.code, currency: scope.currency }, ...facets, hero: homepageHero, homepageSections,
        appearance: resolveAppearance('storefront', scope.tenantId, scope.storeId) };
    },
    async detail(input, slug) {
      const scope = await resolve(input); const product = await dao.findProduct({ scope, slug });
      if (!product) throw new AppError({ code: "PRODUCT_NOT_FOUND", message: "This product is unavailable.", status: 404 });
      const [variants, images, fields, reviews, sizeGuide, structuredSpecifications] = await Promise.all([
        dao.listVariants({ scope, productId: product.id }),
        media({ tenantId: scope.tenantId, productId: product.id }),
        customFields({ tenantId: scope.tenantId, productId: product.id }),
        dao.listReviews({ scope, productId: product.id }),
        product.vertical === 'CLOTHING' ? guide({ tenantId: scope.tenantId, productId: product.id }) : null,
        specs({tenantId:scope.tenantId,productId:product.id})
      ]);
      // Display only explicitly selected public specifications. Demo aggregate ratings are not reviews.
      const allowed = new Set(["Material", "Fit", "Care", "Origin", "Connectivity", "Battery", "Charging", "Warranty",
        "Dimensions", "Assembly", "Skin type", "Routine", "Formulation", "Shelf life", "Activity", "Storage",
        "Pack", "Diet", "Returns", "Age", "Safety", "Pieces", "Format", "Language", "Genre", "Publisher"]);
      const specifications = Object.fromEntries(fields.filter((field) => allowed.has(field.label))
        .map((field) => [field.label, String(field.value)]));
      // Preserve the existing legacy public allowlist; never publish arbitrary custom fields.
      for (const field of structuredSpecifications) specifications[field.label] = field.displayValue;
      const variantIds = new Set(variants.map((variant) => variant.id));
      const colorIds = new Set(variants.map((variant) => variant.colorId).filter(Boolean));
      return { ...product, variants, specifications, structuredSpecifications, reviewsList: reviews, sizeGuide,
        images: images.filter((item) => (!item.variantId || variantIds.has(item.variantId))
          && (!item.colorOptionId || colorIds.has(item.colorOptionId)))
          .map((item) => ({ id: item.id, url: item.url, alt: item.altText || product.name,
            variantId: item.variantId, colorId: item.colorOptionId, role: item.role, sortOrder: item.sortOrder })) };
    }
  };
}
