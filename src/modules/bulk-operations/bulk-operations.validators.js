import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
export const typeSchema = Joi.object({ type: Joi.string().uppercase().valid("PRODUCT", "PRICING", "INVENTORY").required() }).required();
export const jobSchema = Joi.object({ jobId: uuid.required() }).required();
export const typedJobSchema = Joi.object({ type: Joi.string().uppercase().valid("PRODUCT", "PRICING", "INVENTORY").required(), jobId: uuid.required() }).required();
export const validateImportSchema = Joi.object({
  fileName: Joi.string().trim().min(1).max(255).pattern(/\.csv$/i).required(),
  csv: Joi.string().min(1).max(5 * 1024 * 1024).required()
}).required();
export const listJobsSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1), pageSize: Joi.number().integer().min(1).max(100).default(10)
}).required();
export const bulkStatusSchema = Joi.object({
  productIds: Joi.array().items(uuid.required()).min(1).max(500).unique().required(),
  action: Joi.string().lowercase().valid("submit", "archive", "restore").required()
}).required();
export const bulkPublishSchema = Joi.object({ productIds: Joi.array().items(uuid.required()).min(1).max(500).unique().required() }).required();

function validationError(validation) {
  return new AppError({ code: "VALIDATION_FAILED", message: "Check the highlighted fields and try again.", status: 422,
    details: validation.details.map((detail) => ({ field: detail.path.join("."), code: detail.type, message: detail.message })) });
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
