import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
const page = { search: Joi.string().trim().max(190).allow("").default(""),
  page: Joi.number().integer().min(1).default(1), pageSize: Joi.number().integer().min(1).max(100).default(10) };
export const listSuppliersSchema = Joi.object({ ...page,
  status: Joi.string().uppercase().valid("ALL", "ACTIVE", "INACTIVE").default("ALL") }).required();
export const listPurchaseOrdersSchema = Joi.object({ ...page, status: Joi.string().uppercase()
  .valid("ALL", "DRAFT", "APPROVED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED").default("ALL") }).required();
export const supplierParamsSchema = Joi.object({ supplierId: uuid.required() }).required();
export const orderParamsSchema = Joi.object({ purchaseOrderId: uuid.required() }).required();
export const supplierSchema = Joi.object({
  code: Joi.string().trim().uppercase().pattern(/^[A-Z0-9][A-Z0-9_-]{1,49}$/).required(),
  legalName: Joi.string().trim().min(2).max(190).required(), displayName: Joi.string().trim().min(2).max(190).required(),
  gstin: Joi.string().trim().uppercase().pattern(/^([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])?$/).allow("").default(""),
  pan: Joi.string().trim().uppercase().pattern(/^([A-Z]{5}[0-9]{4}[A-Z])?$/).allow("").default(""),
  contactName: Joi.string().trim().max(190).allow("").default(""),
  email: Joi.string().trim().lowercase().email().max(254).allow("").default(""),
  phone: Joi.string().trim().max(32).allow("").default(""),
  status: Joi.string().uppercase().valid("ACTIVE", "INACTIVE").default("ACTIVE"),
  paymentTermsDays: Joi.number().integer().min(0).max(365).allow(null, "").default(null)
}).required();
export const createPurchaseOrderSchema = Joi.object({
  supplierId: uuid.required(), warehouseId: uuid.required(), expectedAt: Joi.date().iso().allow(null, "").default(null),
  notes: Joi.string().trim().max(1000).allow("").default(""), items: Joi.array().items(Joi.object({
    offerId: uuid.required(), quantity: Joi.number().precision(6).greater(0).max(999999999).required(),
    unitCost: Joi.number().precision(4).min(0).max(999999999).required(),
    taxRate: Joi.number().precision(6).min(0).max(100).default(0)
  })).min(1).max(100).unique("offerId").required()
}).required();

function validationError(validation) { return new AppError({ code: "VALIDATION_FAILED",
  message: "Check the highlighted fields and try again.", status: 422,
  details: validation.details.map((detail) => ({ field: detail.path.join("."), code: detail.type, message: detail.message })) }); }
function validate(schema, source) { return (req, _res, next) => { const result = schema.validate(req[source],
  { abortEarly: false, stripUnknown: true, convert: true }); if (result.error) return next(validationError(result.error));
  req.validated = { ...(req.validated || {}), [source]: result.value }; next(); }; }
export const validateBody = (schema) => validate(schema, "body");
export const validateParams = (schema) => validate(schema, "params");
export const validateQuery = (schema) => validate(schema, "query");
