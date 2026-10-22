import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";
const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
const paging = { search: Joi.string().trim().max(190).allow("").default(""), page: Joi.number().integer().min(1).default(1), pageSize: Joi.number().integer().min(1).max(100).default(10) };
export const listBundlesSchema = Joi.object(paging).required();
export const listVariantsSchema = Joi.object({ ...paging, kind: Joi.string().uppercase().valid("ALL", "BUNDLE", "STANDARD").default("ALL") }).required();
export const bundleSchema = Joi.object({ bundleVariantId: uuid.required() }).required();
export const componentSchema = Joi.object({ bundleVariantId: uuid.required(), componentId: uuid.required() }).required();
export const createComponentSchema = Joi.object({ componentVariantId: uuid.required(), quantity: Joi.number().precision(6).greater(0).max(999999).required(),
  isOptional: Joi.boolean().default(false), sortOrder: Joi.number().integer().min(0).max(9999).allow(null).default(null) }).required();
export const updateComponentSchema = Joi.object({ quantity: Joi.number().precision(6).greater(0).max(999999).required(),
  isOptional: Joi.boolean().default(false), sortOrder: Joi.number().integer().min(0).max(9999).required() }).required();
function error(validation) { return new AppError({ code: "VALIDATION_FAILED", message: "Check the highlighted fields and try again.", status: 422,
  details: validation.details.map((item) => ({ field: item.path.join("."), code: item.type, message: item.message })) }); }
function validate(schema, source) { return (req, _res, next) => { const result = schema.validate(req[source], { abortEarly: false, convert: true, stripUnknown: true });
  if (result.error) return next(error(result.error)); req.validated = { ...req.validated, [source]: result.value }; next(); }; }
export const validateBody = (schema) => validate(schema, "body"); export const validateParams = (schema) => validate(schema, "params"); export const validateQuery = (schema) => validate(schema, "query");
