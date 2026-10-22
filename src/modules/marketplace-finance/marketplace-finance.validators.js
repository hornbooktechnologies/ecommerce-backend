import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
const optionalUuid = uuid.allow(null, "").default(null);

export const financeWorkspaceSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  merchantId: optionalUuid,
  entryType: Joi.string().uppercase().valid("ALL", "SALE_CREDIT", "COMMISSION_DEBIT", "COMMISSION_GST_DEBIT",
    "RETURN_DEBIT", "ADJUSTMENT_CREDIT", "ADJUSTMENT_DEBIT").default("ALL"),
  settlementStatus: Joi.string().uppercase().valid("ALL", "UNSETTLED", "IN_SETTLEMENT", "SETTLED").default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
}).required();

export const commissionRuleParamsSchema = Joi.object({ ruleId: uuid.required() }).required();

export const commissionRuleSchema = Joi.object({
  scopeType: Joi.string().uppercase().valid("GLOBAL", "MERCHANT", "STORE").default("GLOBAL"),
  merchantId: optionalUuid,
  storeId: optionalUuid,
  commissionType: Joi.string().uppercase().valid("PERCENTAGE", "FIXED").default("PERCENTAGE"),
  commissionPercent: Joi.number().precision(4).min(0).max(100).allow(null, "").default(null),
  commissionAmount: Joi.number().precision(4).min(0).max(999999999).allow(null, "").default(null),
  minimumCommission: Joi.number().precision(4).min(0).max(999999999).allow(null, "").default(null),
  maximumCommission: Joi.number().precision(4).min(0).max(999999999).allow(null, "").default(null),
  appliesOn: Joi.string().uppercase().valid("TAXABLE_VALUE", "ITEM_TOTAL", "ORDER_TOTAL").default("TAXABLE_VALUE"),
  priority: Joi.number().integer().min(0).max(9999).default(0),
  effectiveFrom: Joi.date().iso().required(),
  effectiveTo: Joi.date().iso().allow(null, "").default(null),
  status: Joi.string().uppercase().valid("ACTIVE", "INACTIVE").default("ACTIVE")
}).custom((value, helpers) => {
  value.merchantId = value.merchantId || null; value.storeId = value.storeId || null;
  value.effectiveTo = value.effectiveTo || null;
  if (value.scopeType === "GLOBAL" && (value.merchantId || value.storeId)) return helpers.error("rule.globalScope");
  if (value.scopeType === "MERCHANT" && !value.merchantId) return helpers.error("rule.merchantRequired");
  if (value.scopeType === "STORE" && !value.storeId) return helpers.error("rule.storeRequired");
  if (value.commissionType === "PERCENTAGE" && value.commissionPercent === null) return helpers.error("rule.percentRequired");
  if (value.commissionType === "FIXED" && value.commissionAmount === null) return helpers.error("rule.amountRequired");
  if (value.minimumCommission !== null && value.maximumCommission !== null
    && value.maximumCommission < value.minimumCommission) return helpers.error("rule.commissionRange");
  if (value.effectiveTo && new Date(value.effectiveTo) <= new Date(value.effectiveFrom)) return helpers.error("rule.dateRange");
  return value;
}).messages({
  "rule.globalScope": "Global rules cannot target a merchant or store.",
  "rule.merchantRequired": "Select a merchant for a merchant rule.",
  "rule.storeRequired": "Select a store for a store rule.",
  "rule.percentRequired": "Enter a commission percentage.",
  "rule.amountRequired": "Enter a fixed commission amount.",
  "rule.commissionRange": "Maximum commission must be greater than or equal to minimum commission.",
  "rule.dateRange": "Effective end must be later than effective start."
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
