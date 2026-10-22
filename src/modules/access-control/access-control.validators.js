import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
const assignment = Joi.object({
  roleId: uuid.required(),
  scopeType: Joi.string().valid("TENANT", "STORE", "MERCHANT", "WAREHOUSE").required(),
  scopeId: uuid.allow(null).when("scopeType", {
    is: "TENANT",
    then: Joi.optional().default(null),
    otherwise: Joi.required()
  })
});

export const listUsersSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "INVITED", "ACTIVE", "SUSPENDED").default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
}).required();

export const userIdSchema = Joi.object({ userId: uuid.required() }).required();
export const roleIdSchema = Joi.object({ roleId: uuid.required() }).required();

export const inviteUserSchema = Joi.object({
  email: Joi.string().trim().lowercase().email().max(254).required(),
  firstName: Joi.string().trim().min(1).max(100).required(),
  lastName: Joi.string().trim().max(100).allow("").default(""),
  temporaryPassword: Joi.string().min(12).max(200).required(),
  assignments: Joi.array().items(assignment).min(1).max(20).required()
}).required();

export const roleSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  level: Joi.string().valid("TENANT", "VENDOR").default("TENANT"),
  permissionKeys: Joi.array().items(Joi.string().trim().max(120)).unique().min(1).max(200).required()
}).required();

export const updateRoleSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120),
  permissionKeys: Joi.array().items(Joi.string().trim().max(120)).unique().min(1).max(200)
}).min(1).required();

export const assignmentsSchema = Joi.object({
  assignments: Joi.array().items(assignment).min(1).max(20).required()
}).required();

function validationError(validation) {
  return new AppError({
    code: "VALIDATION_FAILED",
    message: "Check the highlighted fields and try again.",
    status: 422,
    details: validation.details.map((detail) => ({
      field: detail.path.join("."), code: detail.type, message: detail.message
    }))
  });
}

function validate(schema, source) {
  return (req, _res, next) => {
    const { value, error } = schema.validate(req[source], {
      abortEarly: false, convert: true, stripUnknown: true
    });
    if (error) return next(validationError(error));
    req.validated = { ...req.validated, [source]: value };
    next();
  };
}

export const validateBody = (schema) => validate(schema, "body");
export const validateParams = (schema) => validate(schema, "params");
export const validateQuery = (schema) => validate(schema, "query");
