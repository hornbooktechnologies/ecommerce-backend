import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
const status = Joi.string().uppercase().valid("ACTIVE", "INACTIVE");
const date = Joi.string().isoDate();

export const registrationParamsSchema = Joi.object({ registrationId: uuid.required() }).required();
export const categoryParamsSchema = Joi.object({ categoryId: uuid.required() }).required();
export const rateParamsSchema = Joi.object({ rateId: uuid.required() }).required();
export const invoiceSeriesParamsSchema = Joi.object({ seriesId: uuid.required() }).required();
export const documentParamsSchema = Joi.object({ documentId: uuid.required() }).required();

const registrationFields = {
  storeId: uuid.allow(null, "").default(null),
  gstin: Joi.string().trim().uppercase()
    .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/).required(),
  legalName: Joi.string().trim().min(2).max(190).required(),
  tradeName: Joi.string().trim().max(190).allow("").default(""),
  registrationType: Joi.string().uppercase().valid("REGULAR", "COMPOSITION", "SEZ").default("REGULAR"),
  stateCode: Joi.string().trim().pattern(/^[0-9]{2}$/).required(),
  stateName: Joi.string().trim().min(2).max(120).required(),
  line1: Joi.string().trim().min(3).max(255).required(),
  line2: Joi.string().trim().max(255).allow("").default(""),
  city: Joi.string().trim().min(2).max(120).required(),
  postalCode: Joi.string().trim().pattern(/^\d{6}$/).required(),
  effectiveFrom: date.allow(null, "").default(null),
  effectiveTo: date.allow(null, "").default(null),
  eInvoiceEnabled: Joi.boolean().default(false),
  eWayBillEnabled: Joi.boolean().default(false),
  status: status.default("ACTIVE")
};

function validateRegistration(value, helpers) {
  if (value.gstin.slice(0, 2) !== value.stateCode) {
    return helpers.error("any.custom", { message: "GSTIN must start with the selected GST state code." });
  }
  if (value.effectiveFrom && value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
    return helpers.error("any.custom", { message: "Effective-to date must be after the effective-from date." });
  }
  return value;
}

export const createRegistrationSchema = Joi.object(registrationFields).custom(validateRegistration).required();
export const updateRegistrationSchema = Joi.object(registrationFields).custom(validateRegistration).required();

const categoryFields = {
  code: Joi.string().trim().uppercase().pattern(/^[A-Z0-9][A-Z0-9_-]*$/).min(2).max(50).required(),
  name: Joi.string().trim().min(2).max(120).required(),
  supplyType: Joi.string().uppercase().valid("GOODS", "SERVICES").default("GOODS"),
  hsnSacCode: Joi.string().trim().pattern(/^\d{4,8}$/).required(),
  status: status.default("ACTIVE")
};

export const createCategorySchema = Joi.object(categoryFields).required();
export const updateCategorySchema = Joi.object(categoryFields).required();

const rateFields = {
  gstRate: Joi.number().precision(6).min(0).max(100).required(),
  cessRate: Joi.number().precision(6).min(0).max(100).default(0),
  cessAmount: Joi.number().precision(4).min(0).default(0),
  effectiveFrom: date.required(),
  effectiveTo: date.allow(null, "").default(null),
  status: status.default("ACTIVE")
};

function validateRate(value, helpers) {
  if (value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
    return helpers.error("any.custom", { message: "Effective-to date must be after the effective-from date." });
  }
  return value;
}

export const createRateSchema = Joi.object(rateFields).custom(validateRate).required();
export const updateRateSchema = Joi.object(rateFields).custom(validateRate).required();

const invoiceSeriesFields = {
  registrationId: uuid.required(),
  documentType: Joi.string().uppercase().valid("TAX_INVOICE", "CREDIT_NOTE", "DEBIT_NOTE").required(),
  financialYear: Joi.string().trim().pattern(/^\d{4}-\d{2}$/).required(),
  prefix: Joi.string().trim().uppercase().pattern(/^[A-Z0-9][A-Z0-9/-]*$/).min(1).max(20).required(),
  nextNumber: Joi.number().integer().min(1).max(999999999999).required(),
  numberPadding: Joi.number().integer().min(3).max(12).required()
};

function validateFinancialYear(value, helpers) {
  const [start, end] = value.financialYear.split("-").map(Number);
  if ((start + 1) % 100 !== end) {
    return helpers.error("any.custom", { message: "Financial year must use the YYYY-YY format, for example 2026-27." });
  }
  return value;
}

export const createInvoiceSeriesSchema = Joi.object(invoiceSeriesFields).custom(validateFinancialYear).required();
export const updateInvoiceSeriesSchema = Joi.object({
  ...invoiceSeriesFields,
  version: Joi.number().integer().min(0).required()
}).custom(validateFinancialYear).required();

export const issueTaxInvoiceSchema = Joi.object({
  sellerOrderId: uuid.required(),
  seriesId: uuid.required(),
  documentDate: date.required()
}).custom((value, helpers) => {
  if (value.documentDate.slice(0, 10) > new Date().toISOString().slice(0, 10)) {
    return helpers.error("any.custom", { message: "Document date cannot be in the future." });
  }
  return { ...value, documentDate: value.documentDate.slice(0, 10) };
}).required();

function validationError(error) {
  return new AppError({ code: "VALIDATION_FAILED", message: "Check the highlighted fields and try again.", status: 422,
    details: error.details.map((detail) => ({ field: detail.path.join("."), code: detail.type,
      message: detail.context?.message || detail.message })) });
}

function validate(source, schema) {
  return (req, _res, next) => {
    const result = schema.validate(req[source], { abortEarly: false, stripUnknown: true, convert: true });
    if (result.error) return next(validationError(result.error));
    req.validated = { ...(req.validated || {}), [source]: result.value };
    next();
  };
}

export const validateBody = (schema) => validate("body", schema);
export const validateParams = (schema) => validate("params", schema);
