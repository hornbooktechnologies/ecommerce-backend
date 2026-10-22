import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
export const offerIdSchema = Joi.object({ offerId: uuid.required() }).required();
export const sellerOrderIdSchema = Joi.object({ sellerOrderId: uuid.required() }).required();
export const sellerOrderFulfillmentIdSchema = Joi.object({ sellerOrderId: uuid.required(),
  fulfillmentId: uuid.required() }).required();
export const listSellerOrdersSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "PENDING", "PLACED", "CONFIRMED",
    "PROCESSING", "COMPLETED", "CANCELLED").default("ALL"),
  fulfillmentStatus: Joi.string().uppercase().valid("ALL", "UNFULFILLED", "PROCESSING",
    "PARTIALLY_FULFILLED", "FULFILLED", "CANCELLED").default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().valid(10, 20, 50, 100).default(10)
}).required();
export const sellerOrderDecisionSchema = Joi.object({
  action: Joi.string().uppercase().valid("ACCEPT", "REJECT").required(),
  reasonCode: Joi.string().trim().uppercase().pattern(/^[A-Z0-9_]+$/).max(50).allow("").default(""),
  notes: Joi.string().trim().max(1000).allow("").default("")
}).custom((value, helpers) => value.action === "REJECT" && value.notes.length < 3
  ? helpers.error("sellerOrder.rejectNote") : value)
  .messages({ "sellerOrder.rejectNote": "Add a rejection note with at least 3 characters." }).required();
export const allocateSellerOrderFulfillmentSchema = Joi.object({
  warehouseId: uuid.required(),
  serialAssignments: Joi.array().items(Joi.object({
    orderItemId: uuid.required(),
    bundleComponentId: uuid.allow(null),
    serialIds: Joi.array().items(uuid.required()).unique().max(100).required()
  })).max(100).default([]),
  notes: Joi.string().trim().max(1000).allow("").default("")
}).required();
export const transitionSellerOrderFulfillmentSchema = Joi.object({
  status: Joi.string().uppercase().valid("PICKING", "PACKED", "DISPATCHED", "COMPLETED").required(),
  providerCode: Joi.string().trim().uppercase().pattern(/^[A-Z0-9_-]+$/).max(50).allow("").default(""),
  serviceCode: Joi.string().trim().uppercase().pattern(/^[A-Z0-9_-]+$/).max(80).allow("").default(""),
  trackingNumber: Joi.string().trim().max(190).allow("").default(""),
  packageCount: Joi.number().integer().min(1).max(999).default(1),
  packageWeight: Joi.number().precision(6).greater(0).allow(null).default(null),
  location: Joi.string().trim().max(190).allow("").default(""),
  notes: Joi.string().trim().max(1000).allow("").default("")
}).custom((value, helpers) => value.status === "DISPATCHED"
  && (!value.providerCode || !value.trackingNumber) ? helpers.error("fulfillment.shipping") : value)
  .messages({ "fulfillment.shipping": "Carrier and tracking number are required for dispatch." }).required();
export const updateProfileSchema = Joi.object({
  supportEmail: Joi.string().trim().lowercase().email().max(254),
  supportPhone: Joi.string().trim().pattern(/^\+?[0-9][0-9 -]{7,30}$/),
  contactPerson: Joi.string().trim().min(2).max(190),
  notes: Joi.string().trim().max(2000).allow("")
}).min(1).required();
export const updateOfferSchema = Joi.object({
  status: Joi.string().uppercase().valid("ACTIVE", "INACTIVE"),
  handlingTimeHours: Joi.number().integer().min(0).max(720),
  listPrice: Joi.number().precision(4).greater(0),
  salePrice: Joi.number().precision(4).greater(0),
  costPrice: Joi.number().precision(4).min(0).allow(null)
}).min(1).required();

function validate(part, schema) {
  return (req, _res, next) => {
    const result = schema.validate(req[part], { abortEarly: false, convert: true, stripUnknown: true });
    if (result.error) return next(new AppError({ code: "VALIDATION_FAILED",
      message: "Check the highlighted fields and try again.", status: 422,
      details: result.error.details.map((item) => ({ field: item.path.join("."), code: item.type, message: item.message })) }));
    req.validated = { ...(req.validated || {}), [part]: result.value }; next();
  };
}
export const validateBody = (schema) => validate("body", schema);
export const validateParams = (schema) => validate("params", schema);
export const validateQuery = (schema) => validate("query", schema);
