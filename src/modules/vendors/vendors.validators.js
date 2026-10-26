import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
const optionalMoney = Joi.number().precision(4).min(0).allow(null);

export const listVendorsSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "PENDING", "ACTIVE", "SUSPENDED").default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().valid(10, 20, 50, 100).default(10)
}).required();

export const vendorOptionsSchema = Joi.object({
  variantSearch: Joi.string().trim().max(120).allow("").default("")
}).required();

export const vendorIdSchema = Joi.object({ vendorId: uuid.required() }).required();
export const vendorOfferIdSchema = Joi.object({ vendorId: uuid.required(), offerId: uuid.required() }).required();
export const vendorDocumentIdSchema = Joi.object({ vendorId: uuid.required(), documentId: uuid.required() }).required();
export const uploadVendorLogoSchema = Joi.object({
  fileName: Joi.string().trim().max(255).required()
}).required();
export const uploadVendorDocumentSchema = Joi.object({
  fileName: Joi.string().trim().max(255).required(),
  documentType: Joi.string().uppercase().valid("PAN_CARD", "GST_CERTIFICATE", "BANK_PROOF",
    "INCORPORATION_CERTIFICATE", "ADDRESS_PROOF", "OTHER").required(),
  documentNumber: Joi.string().trim().max(120).allow("").default(""),
  expiresAt: Joi.string().isoDate().allow("").default("")
}).required();
export const vendorDocumentDecisionSchema = Joi.object({
  decision: Joi.string().uppercase().valid("VERIFIED", "REJECTED").required(),
  rejectionReason: Joi.string().trim().max(500).when("decision", {
    is: "REJECTED", then: Joi.string().trim().min(3).max(500).required(),
    otherwise: Joi.string().trim().max(500).allow("").default("")
  })
}).required();

const vendorFields = {
  merchantCode: Joi.string().trim().uppercase().pattern(/^[A-Z0-9][A-Z0-9_-]{2,39}$/).required(),
  displayName: Joi.string().trim().min(2).max(190).required(),
  legalName: Joi.string().trim().min(2).max(190).required(),
  pan: Joi.string().trim().uppercase().pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/).required(),
  gstin: Joi.string().trim().uppercase().pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/).required(),
  supportEmail: Joi.string().trim().lowercase().email().max(254).required(),
  supportPhone: Joi.string().trim().pattern(/^\+?[0-9][0-9 -]{7,30}$/).required(),
  businessType: Joi.string().uppercase().valid("PROPRIETORSHIP", "PARTNERSHIP", "PRIVATE_LIMITED", "PUBLIC_LIMITED", "LLP").required(),
  contactPerson: Joi.string().trim().min(2).max(190).required(),
  defaultCommissionPercent: Joi.number().precision(3).min(0).max(100).default(0),
  settlementCycleDays: Joi.number().integer().min(1).max(90).default(7),
  notes: Joi.string().trim().max(2000).allow("").default(""),
  storeIds: Joi.array().items(uuid).unique().min(1).max(100).required()
};

export const createVendorSchema = Joi.object({
  ...vendorFields,
  address: Joi.object({
    line1: Joi.string().trim().min(3).max(255).required(),
    line2: Joi.string().trim().max(255).allow("").default(""),
    city: Joi.string().trim().min(2).max(120).required(),
    district: Joi.string().trim().max(120).allow("").default(""),
    stateCode: Joi.string().trim().uppercase().length(2).required(),
    stateName: Joi.string().trim().min(2).max(120).required(),
    postalCode: Joi.string().trim().pattern(/^[1-9][0-9]{5}$/).required()
  }).required()
}).required();

export const updateVendorSchema = Joi.object({
  displayName: vendorFields.displayName.optional(), legalName: vendorFields.legalName.optional(),
  supportEmail: vendorFields.supportEmail.optional(), supportPhone: vendorFields.supportPhone.optional(),
  businessType: vendorFields.businessType.optional(), contactPerson: vendorFields.contactPerson.optional(),
  defaultCommissionPercent: vendorFields.defaultCommissionPercent.optional(),
  settlementCycleDays: vendorFields.settlementCycleDays.optional(), notes: vendorFields.notes.optional(),
  storeIds: vendorFields.storeIds.optional()
}).min(1).required();

export const vendorDecisionSchema = Joi.object({
  notes: Joi.string().trim().max(1000).allow("").default("")
}).required();

export const inviteVendorUserSchema = Joi.object({
  email: Joi.string().trim().lowercase().email().max(254).required(),
  firstName: Joi.string().trim().min(1).max(100).required(),
  lastName: Joi.string().trim().max(100).allow("").default(""),
  temporaryPassword: Joi.string().min(12).max(200).required(),
  roleKey: Joi.string().valid("vendor_owner", "vendor_catalog_manager").default("vendor_owner")
}).required();

export const createVendorOfferSchema = Joi.object({
  storeId: uuid.required(), variantId: uuid.required(),
  sellerSku: Joi.string().trim().uppercase().min(2).max(100).required(),
  fulfillmentType: Joi.string().uppercase().valid("MERCHANT", "PLATFORM").default("MERCHANT"),
  handlingTimeHours: Joi.number().integer().min(0).max(720).default(24),
  listPrice: Joi.number().precision(4).greater(0).required(),
  salePrice: Joi.number().precision(4).greater(0).required(),
  costPrice: optionalMoney.default(null)
}).required();

export const updateVendorOfferSchema = Joi.object({
  status: Joi.string().uppercase().valid("ACTIVE", "INACTIVE"),
  handlingTimeHours: Joi.number().integer().min(0).max(720),
  listPrice: Joi.number().precision(4).greater(0), salePrice: Joi.number().precision(4).greater(0),
  costPrice: optionalMoney
}).min(1).required();

function validationError(validation) {
  return new AppError({ code: "VALIDATION_FAILED", message: "Check the highlighted fields and try again.", status: 422,
    details: validation.details.map((detail) => ({ field: detail.path.join("."), code: detail.type, message: detail.message })) });
}

function validator(part, schema) {
  return (req, _res, next) => {
    const validation = schema.validate(req[part], { abortEarly: false, convert: true, stripUnknown: true });
    if (validation.error) return next(validationError(validation.error));
    req.validated = { ...(req.validated || {}), [part]: validation.value };
    next();
  };
}

export const validateBody = (schema) => validator("body", schema);
export const validateParams = (schema) => validator("params", schema);
export const validateQuery = (schema) => validator("query", schema);
