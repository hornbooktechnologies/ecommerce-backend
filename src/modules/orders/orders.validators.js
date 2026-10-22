import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });

export const listOrdersSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "DRAFT", "PLACED", "CONFIRMED", "PROCESSING", "COMPLETED", "CANCELLED").default("ALL"),
  paymentStatus: Joi.string().uppercase().valid("ALL", "UNPAID", "PENDING", "PAID", "PARTIALLY_REFUNDED", "REFUNDED", "FAILED").default("ALL"),
  fulfillmentStatus: Joi.string().uppercase().valid("ALL", "UNFULFILLED", "PROCESSING", "PARTIALLY_FULFILLED", "FULFILLED", "CANCELLED").default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
}).required();

export const orderItemSchema = Joi.object({ orderId: uuid.required() }).required();
export const fulfillmentItemSchema = Joi.object({ orderId: uuid.required(),
  fulfillmentId: uuid.required() }).required();

const customerSchema = Joi.object({
  firstName: Joi.string().trim().min(1).max(100).required(),
  lastName: Joi.string().trim().max(100).allow("").default(""),
  email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).allow("").default(""),
  phone: Joi.string().trim().max(32).allow("").default("")
}).custom((value, helpers) => value.email || value.phone ? value : helpers.error("customer.contact"))
  .messages({ "customer.contact": "Enter a customer email address or phone number." });

const addressSchema = Joi.object({
  line1: Joi.string().trim().min(3).max(255).required(),
  line2: Joi.string().trim().max(255).allow("").default(""),
  landmark: Joi.string().trim().max(190).allow("").default(""),
  city: Joi.string().trim().min(2).max(120).required(),
  stateCode: Joi.string().trim().uppercase().length(2).required(),
  stateName: Joi.string().trim().min(2).max(120).required(),
  postalCode: Joi.string().trim().pattern(/^\d{6}$/).required()
});

export const createOrderSchema = Joi.object({
  storeId: uuid.required(),
  customer: customerSchema.required(),
  shippingAddress: addressSchema.required(),
  deliverySlotId: uuid.allow(null, "").default(null),
  promotionId: uuid.allow(null, "").default(null),
  couponCode: Joi.string().trim().uppercase().max(80).allow("").default(""),
  items: Joi.array().items(Joi.object({
    offerId: uuid.required(),
    quantity: Joi.number().precision(6).greater(0).required(),
    substitutionPreference: Joi.string().uppercase()
      .valid("ALLOW_SIMILAR", "CONTACT_ME", "NO_SUBSTITUTION").default("CONTACT_ME")
  })).min(1).max(50).unique("offerId").required(),
  customerNotes: Joi.string().trim().max(1000).allow("").default(""),
  internalNotes: Joi.string().trim().max(1000).allow("").default("")
}).required();

export const transitionOrderSchema = Joi.object({
  status: Joi.string().uppercase().valid("PLACED", "CONFIRMED", "PROCESSING", "COMPLETED", "CANCELLED").required(),
  reasonCode: Joi.string().trim().uppercase().pattern(/^[A-Z0-9_]+$/).max(50).allow("").default(""),
  notes: Joi.string().trim().max(1000).allow("").default("")
}).custom((value, helpers) => {
  if (value.status === "CANCELLED" && value.notes.length < 3) return helpers.error("order.cancelNote");
  return value;
}).messages({ "order.cancelNote": "Add a cancellation note with at least 3 characters." }).required();

export const allocateFulfillmentSchema = Joi.object({
  sellerOrderId: uuid.required(),
  warehouseId: uuid.required(),
  serialAssignments: Joi.array().items(Joi.object({
    orderItemId: uuid.required(),
    bundleComponentId: uuid.allow(null),
    serialIds: Joi.array().items(uuid.required()).unique().max(100).required()
  })).max(100).default([]),
  notes: Joi.string().trim().max(1000).allow("").default("")
}).required();

export const transitionFulfillmentSchema = Joi.object({
  status: Joi.string().uppercase().valid("PICKING", "PACKED", "DISPATCHED", "COMPLETED").required(),
  providerCode: Joi.string().trim().uppercase().pattern(/^[A-Z0-9_-]+$/).max(50).allow("").default(""),
  serviceCode: Joi.string().trim().uppercase().pattern(/^[A-Z0-9_-]+$/).max(80).allow("").default(""),
  trackingNumber: Joi.string().trim().max(190).allow("").default(""),
  packageCount: Joi.number().integer().min(1).max(999).default(1),
  packageWeight: Joi.number().precision(6).greater(0).allow(null).default(null),
  location: Joi.string().trim().max(190).allow("").default(""),
  notes: Joi.string().trim().max(1000).allow("").default("")
}).custom((value, helpers) => {
  if (value.status === "DISPATCHED" && (!value.providerCode || !value.trackingNumber)) {
    return helpers.error("fulfillment.shipping");
  }
  return value;
}).messages({ "fulfillment.shipping": "Carrier and tracking number are required for dispatch." }).required();

function validationError(validation) {
  return new AppError({
    code: "VALIDATION_FAILED", message: "Check the highlighted fields and try again.", status: 422,
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
