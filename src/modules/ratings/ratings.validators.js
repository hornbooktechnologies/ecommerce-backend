import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });

export const listRatingsSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "PENDING", "PUBLISHED", "HIDDEN", "FLAGGED").default("ALL"),
  rating: Joi.number().integer().min(0).max(5).default(0),
  productId: uuid.allow(null, "").default(null),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
}).custom((value) => ({ ...value, productId: value.productId || null })).required();

export const ratingParamsSchema = Joi.object({ ratingId: uuid.required() }).required();

export const moderateRatingSchema = Joi.object({
  status: Joi.string().uppercase().valid("PENDING", "PUBLISHED", "HIDDEN", "FLAGGED").required(),
  notes: Joi.string().trim().max(1000).allow("").default("")
}).custom((value, helpers) => {
  if (["HIDDEN", "FLAGGED"].includes(value.status) && value.notes.length < 3) return helpers.error("rating.notesRequired");
  return value;
}).messages({ "rating.notesRequired": "Add a moderation note when hiding or flagging a rating." }).required();

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
