import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
export const listVariantsSchema = Joi.object({ search: Joi.string().trim().max(190).allow("").default(""),
  sourceOnly: Joi.boolean().default(false), page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(30) }).required();
export const listRulesSchema = Joi.object({ search: Joi.string().trim().max(190).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "ACTIVE", "INACTIVE").default("ALL"),
  page: Joi.number().integer().min(1).default(1), pageSize: Joi.number().integer().min(1).max(100).default(10) }).required();
export const ruleIdSchema = Joi.object({ ruleId: uuid.required() }).required();
const ruleFields = { priority: Joi.number().integer().min(1).max(999).default(1),
  maximumPriceDifferencePercent: Joi.number().precision(6).min(0).max(1000).allow(null, "").default(null),
  status: Joi.string().uppercase().valid("ACTIVE", "INACTIVE").default("ACTIVE") };
export const createRuleSchema = Joi.object({ sourceVariantId: uuid.required(), substituteVariantId: uuid.required(), ...ruleFields }).required();
export const updateRuleSchema = Joi.object(ruleFields).required();

function validationError(validation) { return new AppError({ code: "VALIDATION_FAILED", message: "Check the highlighted fields and try again.", status: 422,
  details: validation.details.map((detail) => ({ field: detail.path.join("."), code: detail.type, message: detail.message })) }); }
function validate(schema, source) { return (req, _res, next) => { const { value, error } = schema.validate(req[source], { abortEarly: false, convert: true, stripUnknown: true });
  if (error) return next(validationError(error)); req.validated = { ...req.validated, [source]: value }; next(); }; }
export const validateBody = (schema) => validate(schema, "body");
export const validateParams = (schema) => validate(schema, "params");
export const validateQuery = (schema) => validate(schema, "query");
