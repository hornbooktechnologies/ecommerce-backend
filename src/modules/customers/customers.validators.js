import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });

export const listCustomersSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "ACTIVE", "INACTIVE", "BLOCKED").default("ALL"),
  type: Joi.string().uppercase().valid("ALL", "INDIVIDUAL", "BUSINESS").default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
}).required();

export const customerParamsSchema = Joi.object({ customerId: uuid.required() }).required();

export const updateCustomerSchema = Joi.object({
  firstName: Joi.string().trim().min(1).max(100).required(),
  lastName: Joi.string().trim().max(100).allow("").default(""),
  email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).allow("").default(""),
  phone: Joi.string().trim().max(32).allow("").default(""),
  type: Joi.string().uppercase().valid("INDIVIDUAL", "BUSINESS").required(),
  companyName: Joi.string().trim().max(190).allow("").default(""),
  gstin: Joi.string().trim().uppercase().pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
    .allow("").default(""),
  status: Joi.string().uppercase().valid("ACTIVE", "INACTIVE", "BLOCKED").required(),
  notes: Joi.string().trim().max(2000).allow("").default("")
}).custom((value, helpers) => {
  if (!value.email && !value.phone) return helpers.error("customer.contact");
  if (value.type === "BUSINESS" && !value.companyName) return helpers.error("customer.company");
  return value;
}).messages({
  "customer.contact": "Enter a customer email address or phone number.",
  "customer.company": "Enter the company name for a business customer."
}).required();

function validationError(validation) {
  return new AppError({ code: "VALIDATION_FAILED", message: "Check the highlighted fields and try again.",
    status: 422, details: validation.details.map((detail) => ({ field: detail.path.join("."),
      code: detail.type, message: detail.message })) });
}

function validate(schema, source) {
  return (req, _res, next) => {
    const { value, error } = schema.validate(req[source], { abortEarly: false, convert: true, stripUnknown: true });
    if (error) return next(validationError(error));
    req.validated = { ...req.validated, [source]: value };
    next();
  };
}

export const validateBody = (schema) => validate(schema, "body");
export const validateParams = (schema) => validate(schema, "params");
export const validateQuery = (schema) => validate(schema, "query");
