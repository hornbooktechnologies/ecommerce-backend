import { Router } from "express";
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
  brands: optionIds, colors: optionIds, sizes: optionIds,
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
  router.use(base, (req, res, next) => {
    validate(scopeSchema, req.params);
    res.set("Cache-Control", "no-store"); next();
  });
  router.get(`${base}/config`, async (req, res) => res.json({ data: await service.configuration(req.params) }));
  router.get(`${base}/review-photos/:photoId`,async(req,res)=>sendPhoto(res,await reviewPhoto(req.params,validatePhoto(photoIdSchema,req.params.photoId))));
  router.get(`${base}/delivery-availability`, async (req, res) => {
    const input = validate(Joi.object({ postalCode: Joi.string().trim().pattern(/^[1-9][0-9]{5}$/).required() }), req.query, "Provide only a valid six-digit Indian PIN code.");
    res.json({ data: await service.deliveryAvailability(req.params, input) });
  });
  router.get(`${base}/categories`, async (req, res) => res.json({ data: (await service.configuration(req.params)).categories }));
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
