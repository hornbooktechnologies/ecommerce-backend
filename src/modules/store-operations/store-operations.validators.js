import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
const status = Joi.string().uppercase().valid("ACTIVE", "INACTIVE");
const money = Joi.number().precision(4).min(0).allow(null);

export const storeParamsSchema = Joi.object({ storeId: uuid.required() }).required();
export const zoneParamsSchema = Joi.object({ storeId: uuid.required(), zoneId: uuid.required() }).required();
export const templateParamsSchema = Joi.object({ storeId: uuid.required(), templateId: uuid.required() }).required();

export const listStoresSchema = Joi.object({
  search: Joi.string().trim().max(120).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "ACTIVE", "INACTIVE").default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().valid(10, 20, 50).default(10)
}).required();

const storeFields = {
  name: Joi.string().trim().min(2).max(190).required(),
  legalName: Joi.string().trim().max(190).allow("").default(""),
  status: status.default("ACTIVE"),
  supportEmail: Joi.string().trim().lowercase().email().max(254).allow("").default(""),
  supportPhone: Joi.string().trim().pattern(/^\+?[0-9 -]{8,20}$/).allow("").default(""),
  substitutionsEnabled: Joi.boolean().default(true),
  substitutionPolicy: Joi.string().uppercase().valid("CONTACT_ME", "BEST_MATCH", "NO_SUBSTITUTIONS").default("CONTACT_ME"),
  slotHorizonDays: Joi.number().integer().min(1).max(60).default(14),
  line1: Joi.string().trim().min(3).max(255).required(),
  line2: Joi.string().trim().max(255).allow("").default(""),
  landmark: Joi.string().trim().max(190).allow("").default(""),
  city: Joi.string().trim().min(2).max(120).required(),
  stateCode: Joi.string().trim().uppercase().length(2).required(),
  stateName: Joi.string().trim().min(2).max(120).required(),
  postalCode: Joi.string().trim().pattern(/^\d{6}$/).required()
};

export const createStoreSchema = Joi.object({
  code: Joi.string().trim().uppercase().pattern(/^[A-Z0-9][A-Z0-9_-]*$/).min(2).max(40).required(),
  ...storeFields
}).required();

export const updateStoreSchema = Joi.object(storeFields).required();

export const zoneSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  status: status.default("ACTIVE"),
  minimumOrderAmount: money.default(null),
  deliveryFee: money.default(0),
  freeDeliveryThreshold: money.default(null),
  postalCodes: Joi.array().items(Joi.string().trim().pattern(/^\d{6}$/)).unique().min(1).max(100).required()
}).required();

export const templateSchema = Joi.object({
  zoneId: uuid.required(),
  name: Joi.string().trim().min(2).max(120).required(),
  dayOfWeek: Joi.number().integer().min(0).max(6).required(),
  startTime: Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).required(),
  endTime: Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).required(),
  orderCapacity: Joi.number().integer().min(1).max(10000).required(),
  weightCapacity: Joi.number().precision(6).greater(0).allow(null).default(null),
  cutoffMinutes: Joi.number().integer().min(0).max(10080).default(60),
  status: status.default("ACTIVE")
}).custom((value, helpers) => value.startTime >= value.endTime
  ? helpers.error("any.invalid", { message: "End time must be later than start time." }) : value).required();

export const generateSlotsSchema = Joi.object({
  days: Joi.number().integer().min(1).max(60).default(14)
}).required();

export const assignWarehousesSchema = Joi.object({
  warehouseIds: Joi.array().items(uuid).unique().max(100).default([])
}).required();

function validationError(error) {
  return new AppError({ code: "VALIDATION_FAILED", message: "Check the highlighted fields and try again.", status: 422,
    details: error.details.map((detail) => ({ field: detail.path.join("."), code: detail.type,
      message: detail.context?.message || detail.message })) });
}

function validate(source, schema) {
  return (req, _res, next) => {
    const result = schema.validate(req[source], { abortEarly: false, stripUnknown: true, convert: true });
    if (result.error) return next(validationError(result.error));
    req.validated = { ...(req.validated || {}), [source]: result.value };
    next();
  };
}

export const validateBody = (schema) => validate("body", schema);
export const validateParams = (schema) => validate("params", schema);
export const validateQuery = (schema) => validate("query", schema);
