import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });

export const balanceSchema = Joi.object({ balanceId: uuid.required() }).required();
export const serialSchema = Joi.object({ serialId: uuid.required() }).required();

const traceabilityPage = {
  search: Joi.string().trim().max(190).allow("").default(""),
  warehouseId: uuid.allow("").default(""),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
};

export const listTraceabilityLotsSchema = Joi.object({
  ...traceabilityPage,
  health: Joi.string().uppercase()
    .valid("ALL", "HEALTHY", "EXPIRING", "EXPIRED", "QUARANTINED", "DEPLETED")
    .default("ALL")
}).required();

export const listTraceabilitySerialsSchema = Joi.object({
  ...traceabilityPage,
  status: Joi.string().uppercase()
    .valid("ALL", "AVAILABLE", "RESERVED", "SOLD", "QUARANTINED", "SCRAPPED")
    .default("ALL")
}).required();

export const createWarehouseSchema = Joi.object({
  code: Joi.string().trim().uppercase().pattern(/^[A-Z0-9][A-Z0-9_-]*$/).min(2).max(50).required(),
  name: Joi.string().trim().min(2).max(190).required(),
  line1: Joi.string().trim().min(3).max(255).required(),
  line2: Joi.string().trim().max(255).allow("").default(""),
  city: Joi.string().trim().min(2).max(120).required(),
  stateCode: Joi.string().trim().uppercase().length(2).required(),
  stateName: Joi.string().trim().min(2).max(120).required(),
  postalCode: Joi.string().trim().pattern(/^\d{6}$/).required()
}).required();

export const receiveStockSchema = Joi.object({
  warehouseId: uuid.required(),
  offerId: uuid.required(),
  purchaseOrderId: uuid.allow(null, "").default(null),
  purchaseOrderItemId: uuid.allow(null, "").default(null),
  quantity: Joi.number().precision(6).greater(0).required(),
  unitCost: Joi.number().precision(4).min(0).allow(null).default(null),
  supplierDocumentNumber: Joi.string().trim().max(100).allow("").default(""),
  notes: Joi.string().trim().max(1000).allow("").default(""),
  lotNumber: Joi.string().trim().max(100).allow("").default(""),
  manufacturedAt: Joi.date().iso().allow(null, "").default(null),
  expiresAt: Joi.date().iso().allow(null, "").default(null),
  serialNumbers: Joi.array().items(Joi.string().trim().min(1).max(190)).unique().max(500).default([])
}).custom((value, helpers) => {
  if (Boolean(value.purchaseOrderId) !== Boolean(value.purchaseOrderItemId)) {
    return helpers.error("receipt.purchaseOrderReference");
  }
  return value;
}).messages({ "receipt.purchaseOrderReference": "Purchase order and line references must be supplied together." }).required();

export const adjustStockSchema = Joi.object({
  balanceId: uuid.required(),
  lotId: uuid.allow(null, "").default(null),
  countedQuantity: Joi.number().precision(6).min(0).required(),
  reasonCode: Joi.string().uppercase().valid("CYCLE_COUNT", "DAMAGE", "LOSS", "FOUND", "DATA_CORRECTION").required(),
  notes: Joi.string().trim().min(3).max(1000).required()
}).required();

export const updateStockPolicySchema = Joi.object({
  safetyStockQuantity: Joi.number().precision(6).min(0).required(),
  reorderPointQuantity: Joi.number().precision(6).min(0).allow(null).required(),
  reorderQuantity: Joi.number().precision(6).greater(0).allow(null).required()
}).required();

export const transferStockSchema = Joi.object({
  sourceBalanceId: uuid.required(),
  destinationWarehouseId: uuid.required(),
  sourceLotId: uuid.allow(null, "").default(null),
  quantity: Joi.number().precision(6).greater(0).required(),
  serialIds: Joi.array().items(uuid.required()).unique().max(500).default([]),
  notes: Joi.string().trim().min(3).max(1000).required()
}).required();

export const reconcileSerialSchema = Joi.object({
  status: Joi.string().uppercase().valid("AVAILABLE", "QUARANTINED", "SCRAPPED").required(),
  reasonCode: Joi.string().uppercase()
    .valid("DAMAGE", "QUALITY_HOLD", "QUALITY_RELEASE", "FOUND", "DATA_CORRECTION")
    .required(),
  notes: Joi.string().trim().min(3).max(1000).required()
}).required();

function validationError(validation) {
  return new AppError({
    code: "VALIDATION_FAILED", message: "Check the highlighted fields and try again.", status: 422,
    details: validation.details.map((detail) => ({
      field: detail.path.join("."), code: detail.type, message: detail.message
    }))
  });
}

export function validateBody(schema) {
  return (req, _res, next) => {
    const validation = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (validation.error) return next(validationError(validation.error));
    req.validated = { ...(req.validated || {}), body: validation.value };
    next();
  };
}

export function validateParams(schema) {
  return (req, _res, next) => {
    const validation = schema.validate(req.params, { abortEarly: false, stripUnknown: true });
    if (validation.error) return next(validationError(validation.error));
    req.validated = { ...(req.validated || {}), params: validation.value };
    next();
  };
}

export function validateQuery(schema) {
  return (req, _res, next) => {
    const validation = schema.validate(req.query, { abortEarly: false, stripUnknown: true });
    if (validation.error) return next(validationError(validation.error));
    req.validated = { ...(req.validated || {}), query: validation.value };
    next();
  };
}
