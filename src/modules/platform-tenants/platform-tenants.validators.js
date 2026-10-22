import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";
import { catalogVerticalCodes } from "../catalog/catalog-verticals.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
const tenantCode = Joi.string().trim().uppercase().pattern(/^[A-Z0-9][A-Z0-9_-]{2,39}$/);

export const listTenantsSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "PENDING", "ACTIVE", "SUSPENDED").default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
}).required();

export const tenantIdSchema = Joi.object({
  tenantId: uuid.required()
}).required();

export const createTenantSchema = Joi.object({
  code: tenantCode.required().messages({
    "string.pattern.base": "Tenant code must use 3-40 uppercase letters, numbers, underscores, or hyphens."
  }),
  legalName: Joi.string().trim().min(2).max(190).required(),
  displayName: Joi.string().trim().min(2).max(190).required(),
  defaultCurrency: Joi.string().valid("INR").default("INR"),
  defaultLanguage: Joi.string().valid("en-IN").default("en-IN"),
  timezone: Joi.string().valid("Asia/Kolkata").default("Asia/Kolkata"),
  catalogVerticals: Joi.array().items(Joi.string().uppercase().valid(...catalogVerticalCodes))
    .min(1).max(catalogVerticalCodes.length).unique().required().messages({
      "array.min": "Select at least one product type.",
      "array.unique": "Each product type can be selected only once.",
      "any.required": "Select at least one product type."
    }),
  owner: Joi.object({
    email: Joi.string().trim().lowercase().email().max(254).required(),
    firstName: Joi.string().trim().min(1).max(100).required(),
    lastName: Joi.string().trim().max(100).allow("").default(""),
    temporaryPassword: Joi.string().min(12).max(200).required()
  }).required(),
  defaultStore: Joi.object({
    code: tenantCode.required(),
    name: Joi.string().trim().min(2).max(190).required(),
    supportEmail: Joi.string().trim().lowercase().email().max(254).allow("", null).default(null),
    supportPhone: Joi.string().trim().max(32).pattern(/^\+?[0-9 ()-]{7,32}$/).allow("", null).default(null)
  }).required()
}).required();

export const updateTenantSchema = Joi.object({
  legalName: Joi.string().trim().min(2).max(190),
  displayName: Joi.string().trim().min(2).max(190),
  timezone: Joi.string().valid("Asia/Kolkata"),
  catalogVerticals: Joi.array().items(Joi.string().uppercase().valid(...catalogVerticalCodes))
    .min(1).max(catalogVerticalCodes.length).unique()
}).min(1).required();

export const transitionTenantSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required()
}).required();

function validationError(error) {
  return new AppError({
    code: "VALIDATION_FAILED",
    message: "Check the highlighted fields and try again.",
    status: 422,
    details: error.details.map((detail) => ({
      field: detail.path.join("."),
      code: detail.type,
      message: detail.message
    }))
  });
}

function validate(schema, source) {
  return (req, _res, next) => {
    const { value, error } = schema.validate(req[source], {
      abortEarly: false,
      convert: true,
      stripUnknown: true
    });

    if (error) {
      return next(validationError(error));
    }

    req.validated = { ...req.validated, [source]: value };
    next();
  };
}

export const validateBody = (schema) => validate(schema, "body");
export const validateParams = (schema) => validate(schema, "params");
export const validateQuery = (schema) => validate(schema, "query");
