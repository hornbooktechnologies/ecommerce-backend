import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
const note = Joi.string().trim().max(2000).allow("").default("");

export const listWarrantiesSchema = Joi.object({
  search: Joi.string().trim().max(120).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "ACTIVE", "EXPIRED", "VOID", "REPLACED").default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().valid(10, 20, 50, 100).default(10)
}).required();

export const listClaimsSchema = Joi.object({
  search: Joi.string().trim().max(120).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "OPEN", "ASSIGNED", "DIAGNOSED", "RESOLVED", "CLOSED").default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().valid(10, 20, 50, 100).default(10)
}).required();

export const warrantyIdSchema = Joi.object({ warrantyId: uuid.required() }).required();
export const claimIdSchema = Joi.object({ claimId: uuid.required() }).required();

export const createClaimSchema = Joi.object({
  warrantyRegistrationId: uuid.required(),
  issueDescription: Joi.string().trim().min(10).max(4000).required()
}).required();

export const assignClaimSchema = Joi.object({
  assignedTo: uuid.required(),
  notes: note
}).required();

export const diagnoseClaimSchema = Joi.object({
  diagnosisNotes: Joi.string().trim().min(5).max(4000).required()
}).required();

export const resolveClaimSchema = Joi.object({
  resolutionType: Joi.string().uppercase().valid("REPAIR", "REPLACEMENT", "REFUND", "NO_FAULT", "OUT_OF_SCOPE").required(),
  resolutionNotes: Joi.string().trim().min(5).max(4000).required()
}).required();

export const closeClaimSchema = Joi.object({ notes: note }).required();

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
