import {specificationQuery} from './specification-filters.validators.js';
import {createMerchandisingPublicRouter} from '../merchandising/merchandising.routes.js';
import {publicCollection,publicCollectionIndex} from '../homepage/collections.service.js';
import {collectionSlug,collectionProducts} from '../homepage/collections.validators.js';
import { Router } from "express";
import {publicProfile as sellerProfile,publicRatings as sellerRatings} from '../seller-profiles/seller-profiles.service.js';
import {uuid as sellerIdSchema,publicQuery as sellerQuery} from '../seller-profiles/seller-profiles.validators.js';
import {discovery as discover} from '../shopping/shopping.service.js';
import {discovery as discoverySchema} from '../shopping/shopping.validators.js';
import {resolveStore} from './storefront.dao.js';
import {publicFile as reviewPhoto} from '../review-photos/review-photos.service.js';
import {uuid as photoIdSchema,validate as validatePhoto,sendPhoto} from '../review-photos/review-photos.validators.js';
import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";
import { createStorefrontService } from "./storefront.service.js";
import {publicList as publicQuestions} from '../questions/questions.service.js';
import {pagination as questionsPagination} from '../questions/questions.validators.js';

const scopeSchema = Joi.object({ tenantCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required(),
  storeCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required() }).unknown(true);
// Bounded comma-separated IDs keep public URLs portable and SQL parameterised.
const optionIds = Joi.string().max(1200).allow("").default("").custom((raw, helpers) => {
  if (!raw) return [];
  const values = raw.split(',');
  if (values.length > 30 || values.some((id) => Joi.string().guid().validate(id).error)) return helpers.error('any.invalid');
  return [...new Set(values)];
});
const filtersSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  category: Joi.string().max(260).allow("").default(""), brand: Joi.string().guid().allow("").default(""),
  brands: optionIds, colors: optionIds, sizes: optionIds, specs: specificationQuery,
  page: Joi.number().integer().min(1).max(10000).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  minPrice: Joi.number().min(0).max(1e12), maxPrice: Joi.number().min(0).max(1e12),
  minRating: Joi.number().min(0).max(5).default(0), minDiscount: Joi.number().min(0).max(100).default(0),
  inStock: Joi.boolean().default(false),
  sort: Joi.string().valid("featured", "newest", "price_asc", "price_desc", "rating", "discount").default("featured")
}).custom((value, helpers) => value.minPrice !== undefined && value.maxPrice !== undefined && value.minPrice > value.maxPrice
  ? helpers.error("any.invalid") : value);
function validate(schema, input, message = "Invalid catalog filters.") {
  const { error, value } = schema.validate(input, { abortEarly: false });
  if (error) throw new AppError({ code: "VALIDATION_FAILED", message, status: 422,
    details: error.details.map((entry) => ({ field: entry.path.join("."), message: entry.message })) });
  return value;
}
export function createStorefrontRouter({ service = createStorefrontService() } = {}) {
  const router = Router(); const base = "/:tenantCode/stores/:storeCode";
  router.use(createMerchandisingPublicRouter());
  router.use(base, (req, res, next) => {
    validate(scopeSchema, req.params);
    res.set("Cache-Control", "no-store"); next();
  });
  router.post(`${base}/discovery`,async(req,res)=>{const input=validate(discoverySchema,req.body);const scope=await resolveStore(req.params);if(!scope)throw new AppError({code:'STORE_NOT_FOUND',message:'This store is unavailable.',status:404});res.json({data:await discover(scope,input)});});
  router.get(`${base}/sellers/:sellerId`,async(req,res)=>res.json({data:await sellerProfile(req.params,validate(sellerIdSchema,req.params.sellerId),validate(sellerQuery,req.query))}));
  router.get(`${base}/sellers/:sellerId/ratings`,async(req,res)=>res.json({data:await sellerRatings(req.params,validate(sellerIdSchema,req.params.sellerId),req.query)}));
  router.get(`${base}/config`, async (req, res) => res.json({ data: await service.configuration(req.params) }));
  router.get(`${base}/review-photos/:photoId`,async(req,res)=>sendPhoto(res,await reviewPhoto(req.params,validatePhoto(photoIdSchema,req.params.photoId))));
  router.get(`${base}/delivery-availability`, async (req, res) => {
    const input = validate(Joi.object({ postalCode: Joi.string().trim().pattern(/^[1-9][0-9]{5}$/).required() }), req.query, "Provide only a valid six-digit Indian PIN code.");
    res.json({ data: await service.deliveryAvailability(req.params, input) });
  });
  router.get(`${base}/categories`, async (req, res) => res.json({ data: (await service.configuration(req.params)).categories }));
  router.get(`${base}/collections`,async(req,res)=>{const scope=await resolveStore(req.params);if(!scope)throw new AppError({code:'STORE_NOT_FOUND',message:'Store is unavailable.',status:404});res.json({data:await publicCollectionIndex(scope,validate(Joi.object({page:Joi.number().integer().min(1).max(10000).default(1),pageSize:Joi.number().integer().min(1).max(100).default(10)}),req.query))});});
  router.get(`${base}/collections/:collectionSlug`,async(req,res)=>{const scope=await resolveStore(req.params);if(!scope)throw new AppError({code:'STORE_NOT_FOUND',message:'Store is unavailable.',status:404});res.json({data:await publicCollection(scope,validate(collectionSlug.required(),req.params.collectionSlug),validate(collectionProducts,req.query))});});
  router.get(`${base}/brands`, async (req, res) => res.json({ data: (await service.configuration(req.params)).brands }));
  router.get(`${base}/products`, async (req, res) => res.json({ data: await service.catalog(req.params, validate(filtersSchema, req.query)) }));
  router.get(`${base}/facets`, async (req, res) => res.json({ data: await service.facets(req.params, validate(filtersSchema, req.query)) }));
  router.get(`${base}/compare`, async (req,res)=>{
    const {items}=validate(Joi.object({items:Joi.string().max(1600).required().custom((raw,helpers)=>{
      const entries=raw.split(',');
      if(entries.length<2||entries.length>4)return helpers.error('any.invalid');
      const selections=entries.map(entry=>{const [slug,offerId,...extra]=entry.split('~');return {slug,offerId,extra};});
      if(selections.some(item=>!/^[a-zA-Z0-9_-]{1,320}$/.test(item.slug)||item.extra.length||(item.offerId!==undefined&&Joi.string().guid().validate(item.offerId).error))||new Set(selections.map(item=>item.slug)).size!==selections.length)return helpers.error('any.invalid');
      return selections.map(({slug,offerId})=>({slug,offerId}));
    })}),req.query,'Choose 2–4 different products of the same type.');
    res.json({data:await service.comparison(req.params,items)});
  });
  router.get(`${base}/products/:slug`, async (req, res) => {
    const slug = validate(Joi.string().pattern(/^[a-zA-Z0-9_-]{1,320}$/).required(), req.params.slug);
    res.json({ data: await service.detail(req.params, slug) });
  });
  router.get(`${base}/products/:slug/questions`,async(req,res)=>res.json({data:await publicQuestions(req.params,validate(Joi.string().pattern(/^[a-zA-Z0-9_-]{1,320}$/).required(),req.params.slug),validate(questionsPagination,req.query))}));
  return router;
}
