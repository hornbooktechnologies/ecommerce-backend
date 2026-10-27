import { Router } from "express";
import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";
import { createStorefrontService } from "./storefront.service.js";

const scopeSchema = Joi.object({ tenantCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required(),
  storeCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required() }).unknown(true);
const filtersSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  category: Joi.string().max(260).allow("").default(""), brand: Joi.string().guid().allow("").default(""),
  page: Joi.number().integer().min(1).max(10000).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  minPrice: Joi.number().min(0).max(1e12), maxPrice: Joi.number().min(0).max(1e12),
  minRating: Joi.number().min(0).max(5).default(0), minDiscount: Joi.number().min(0).max(100).default(0),
  inStock: Joi.boolean().default(false),
  sort: Joi.string().valid("featured", "newest", "price_asc", "price_desc", "rating").default("featured")
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
  router.get(`${base}/delivery-availability`, async (req, res) => {
    const input = validate(Joi.object({ postalCode: Joi.string().trim().pattern(/^[1-9][0-9]{5}$/).required() }), req.query, "Provide only a valid six-digit Indian PIN code.");
    res.json({ data: await service.deliveryAvailability(req.params, input) });
  });
  router.get(`${base}/categories`, async (req, res) => res.json({ data: (await service.configuration(req.params)).categories }));
  router.get(`${base}/brands`, async (req, res) => res.json({ data: (await service.configuration(req.params)).brands }));
  router.get(`${base}/products`, async (req, res) => res.json({ data: await service.catalog(req.params, validate(filtersSchema, req.query)) }));
  router.get(`${base}/products/:slug`, async (req, res) => {
    const slug = validate(Joi.string().pattern(/^[a-zA-Z0-9_-]{1,320}$/).required(), req.params.slug);
    res.json({ data: await service.detail(req.params, slug) });
  });
  return router;
}
