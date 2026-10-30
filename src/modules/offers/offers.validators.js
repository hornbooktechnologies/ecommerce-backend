import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
// PATCH must distinguish omitted fields (preserve) from explicit null/empty (clear).
const nullableQuantity = Joi.number().precision(6).greater(0).max(999999999).allow(null, "");
const nullableMoney = Joi.number().precision(4).min(0).max(999999999).allow(null, "");

export const listOffersSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "DRAFT", "ACTIVE", "INACTIVE").default("ALL"),
  merchantType: Joi.string().uppercase().valid("ALL", "FIRST_PARTY", "VENDOR").default("ALL"),
  storeId: uuid.allow(null, "").default(null),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
}).required();

export const offerOptionsSchema = Joi.object({
  variantSearch: Joi.string().trim().max(190).allow("").default("")
}).required();

export const offerParamsSchema = Joi.object({ offerId: uuid.required() }).required();
export const priceListParamsSchema = Joi.object({ priceListId: uuid.required() }).required();

export const createOfferSchema = Joi.object({
  merchantId: uuid.required(), storeId: uuid.required(), variantId: uuid.required(), priceListId: uuid.required(),
  sellerSku: Joi.string().trim().uppercase().min(2).max(100).required(),
  status: Joi.string().uppercase().valid("DRAFT", "ACTIVE").default("DRAFT"),
  fulfillmentType: Joi.string().uppercase().valid("MERCHANT", "PLATFORM").default("MERCHANT"),
  handlingTimeHours: Joi.number().integer().min(0).max(720).default(24),
  minimumOrderQuantity: nullableQuantity.default(null),
  maximumOrderQuantity: nullableQuantity.default(null),
  listPrice: Joi.number().precision(4).greater(0).max(999999999).required(),
  salePrice: Joi.number().precision(4).greater(0).max(999999999).required(),
  costPrice: nullableMoney.default(null)
}).custom((value, helpers) => {
  if (value.salePrice > value.listPrice) return helpers.error("offer.salePrice");
  if (value.minimumOrderQuantity && value.maximumOrderQuantity
    && value.maximumOrderQuantity < value.minimumOrderQuantity) return helpers.error("offer.quantityRange");
  return value;
}).messages({
  "offer.salePrice": "Selling price cannot exceed MRP.",
  "offer.quantityRange": "Maximum order quantity must be greater than or equal to the minimum."
}).required();

export const updateOfferSchema = Joi.object({
  status: Joi.string().uppercase().valid("DRAFT", "ACTIVE", "INACTIVE"),
  fulfillmentType: Joi.string().uppercase().valid("MERCHANT", "PLATFORM"),
  handlingTimeHours: Joi.number().integer().min(0).max(720),
  minimumOrderQuantity: nullableQuantity,
  maximumOrderQuantity: nullableQuantity,
  priceListId: uuid,
  listPrice: Joi.number().precision(4).greater(0).max(999999999),
  salePrice: Joi.number().precision(4).greater(0).max(999999999),
  costPrice: nullableMoney
}).min(1).required();

export const priceListSchema = Joi.object({
  code: Joi.string().trim().uppercase().pattern(/^[A-Z0-9][A-Z0-9_-]{1,49}$/).required(),
  name: Joi.string().trim().min(2).max(120).required(),
  storeId: uuid.allow(null, "").default(null),
  includesTax: Joi.boolean().default(true),
  priority: Joi.number().integer().min(0).max(9999).default(0),
  startsAt: Joi.date().iso().allow(null, "").default(null),
  endsAt: Joi.date().iso().allow(null, "").default(null),
  status: Joi.string().uppercase().valid("ACTIVE", "INACTIVE").default("ACTIVE")
}).custom((value, helpers) => {
  if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
    return helpers.error("priceList.dateRange");
  }
  value.storeId = value.storeId || null; value.startsAt = value.startsAt || null; value.endsAt = value.endsAt || null;
  return value;
}).messages({
  "string.pattern.base": "Use 2–50 uppercase letters, numbers, hyphens, or underscores.",
  "priceList.dateRange": "End date must be later than the start date."
}).required();

function validationError(validation) {
  return new AppError({ code: "VALIDATION_FAILED", message: "Check the highlighted fields and try again.",
    status: 422, details: validation.details.map((detail) => ({ field: detail.path.join("."),
      code: detail.type, message: detail.message })) });
}

function validate(schema, source) {
  return (req, _res, next) => {
    const { value, error } = schema.validate(req[source], { abortEarly: false, convert: true, stripUnknown: true });
    if (error) return next(validationError(error));
    req.validated = { ...req.validated, [source]: value }; next();
  };
}

export const validateBody = (schema) => validate(schema, "body");
export const validateParams = (schema) => validate(schema, "params");
export const validateQuery = (schema) => validate(schema, "query");
