import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
const nullableLimit = Joi.number().integer().min(1).max(10000000).allow(null).default(null);

export const listPromotionsSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "DRAFT", "ACTIVE", "SCHEDULED", "PAUSED", "EXPIRED").default("ALL"),
  type: Joi.string().uppercase().valid("ALL", "PERCENTAGE", "FIXED_AMOUNT", "FREE_SHIPPING").default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
}).required();

export const promotionParamsSchema = Joi.object({ promotionId: uuid.required() }).required();
export const couponParamsSchema = Joi.object({ promotionId: uuid.required(), couponId: uuid.required() }).required();

export const promotionSchema = Joi.object({
  name: Joi.string().trim().min(2).max(190).required(),
  type: Joi.string().uppercase().valid("PERCENTAGE", "FIXED_AMOUNT", "FREE_SHIPPING").required(),
  storeId: uuid.allow(null, "").default(null),
  priority: Joi.number().integer().min(0).max(9999).default(0),
  stackable: Joi.boolean().default(false),
  startsAt: Joi.date().iso().required(),
  endsAt: Joi.date().iso().allow(null, "").default(null),
  usageLimitTotal: nullableLimit,
  usageLimitPerCustomer: nullableLimit,
  minimumOrderAmount: Joi.number().precision(2).min(0).max(999999999).default(0),
  discountValue: Joi.number().precision(2).min(0).max(999999999).default(0),
  maxDiscountAmount: Joi.number().precision(2).min(0.01).max(999999999).allow(null, "").default(null),
  couponRequired: Joi.boolean().default(false)
}).custom((value, helpers) => {
  if (value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) return helpers.error("promotion.dateRange");
  if (value.type === "PERCENTAGE" && (value.discountValue <= 0 || value.discountValue > 100)) return helpers.error("promotion.percentage");
  if (value.type === "FIXED_AMOUNT" && value.discountValue <= 0) return helpers.error("promotion.fixedAmount");
  if (value.type === "FREE_SHIPPING") { value.discountValue = 0; value.maxDiscountAmount = null; }
  if (value.usageLimitTotal && value.usageLimitPerCustomer && value.usageLimitPerCustomer > value.usageLimitTotal) {
    return helpers.error("promotion.usageLimit");
  }
  value.storeId = value.storeId || null;
  value.endsAt = value.endsAt || null;
  return value;
}).messages({
  "promotion.dateRange": "End date must be later than the start date.",
  "promotion.percentage": "Percentage discount must be greater than 0 and no more than 100.",
  "promotion.fixedAmount": "Fixed discount amount must be greater than 0.",
  "promotion.usageLimit": "Per-customer usage cannot exceed the total usage limit."
}).required();

export const couponSchema = Joi.object({
  code: Joi.string().trim().uppercase().pattern(/^[A-Z0-9][A-Z0-9_-]{2,39}$/).required()
    .messages({ "string.pattern.base": "Use 3–40 uppercase letters, numbers, hyphens, or underscores." }),
  status: Joi.string().uppercase().valid("ACTIVE", "INACTIVE").default("ACTIVE"),
  usageLimit: nullableLimit,
  startsAt: Joi.date().iso().allow(null, "").default(null),
  endsAt: Joi.date().iso().allow(null, "").default(null)
}).custom((value, helpers) => {
  if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) return helpers.error("coupon.dateRange");
  value.startsAt = value.startsAt || null;
  value.endsAt = value.endsAt || null;
  return value;
}).messages({ "coupon.dateRange": "Coupon end date must be later than its start date." }).required();

export const previewPromotionSchema = Joi.object({
  subtotal: Joi.number().precision(2).min(0).max(999999999).required(),
  shippingAmount: Joi.number().precision(2).min(0).max(999999999).default(0),
  couponCode: Joi.string().trim().uppercase().max(80).allow("").default("")
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
    req.validated = { ...req.validated, [source]: value };
    next();
  };
}

export const validateBody = (schema) => validate(schema, "body");
export const validateParams = (schema) => validate(schema, "params");
export const validateQuery = (schema) => validate(schema, "query");
