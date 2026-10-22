import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
const note = Joi.string().trim().max(1000).allow("").default("");

export const listReturnsSchema = Joi.object({
  search: Joi.string().trim().max(120).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "REQUESTED", "APPROVED", "RECEIVED", "INSPECTED", "COMPLETED", "REJECTED").default("ALL"),
  type: Joi.string().uppercase().valid("ALL", "RETURN", "EXCHANGE").default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().valid(10, 20, 50, 100).default(10)
}).required();

export const returnIdSchema = Joi.object({ returnId: uuid.required() }).required();
export const exchangeIdSchema = Joi.object({ exchangeId: uuid.required() }).required();

export const createReturnSchema = Joi.object({
  orderItemId: uuid.required(),
  returnType: Joi.string().uppercase().valid("RETURN", "EXCHANGE").default("RETURN"),
  quantity: Joi.number().precision(6).greater(0).required(),
  serialIds: Joi.array().items(uuid).unique().max(100).default([]),
  reasonCode: Joi.string().uppercase().valid("DAMAGED", "DEFECTIVE", "WRONG_ITEM", "SIZE_FIT", "CHANGED_MIND", "QUALITY", "OTHER").required(),
  customerComments: note
}).required();

export const decisionSchema = Joi.object({ notes: note }).required();
export const rejectReturnSchema = Joi.object({ notes: Joi.string().trim().min(3).max(1000).required() }).required();
export const receiveReturnSchema = Joi.object({ warehouseId: uuid.required(), notes: note }).required();
export const inspectReturnSchema = Joi.object({
  itemCondition: Joi.string().uppercase().valid("NEW", "OPEN_BOX", "USED", "DAMAGED", "DEFECTIVE").required(),
  disposition: Joi.string().uppercase().valid("RESTOCK", "QUARANTINE", "SCRAP").required(),
  notes: note
}).required();
export const completeReturnSchema = Joi.object({
  refundReference: Joi.string().trim().max(190).allow("").default(""),
  notes: note
}).required();
export const createExchangeSchema = Joi.object({ replacementOfferId: uuid.required() }).required();
export const completeExchangeSchema = Joi.object({ notes: note }).required();

function validationError(validation) {
  return new AppError({ code: "VALIDATION_FAILED", message: "Check the highlighted fields and try again.", status: 422,
    details: validation.details.map((detail) => ({ field: detail.path.join("."), code: detail.type, message: detail.message })) });
}

function validator(part, schema) {
  return (req, _res, next) => {
    const validation = schema.validate(req[part], { abortEarly: false, stripUnknown: true });
    if (validation.error) return next(validationError(validation.error));
    req.validated = { ...(req.validated || {}), [part]: validation.value };
    next();
  };
}

export const validateBody = (schema) => validator("body", schema);
export const validateParams = (schema) => validator("params", schema);
export const validateQuery = (schema) => validator("query", schema);
