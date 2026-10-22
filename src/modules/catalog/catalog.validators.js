import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });

export const listProductsSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  status: Joi.string().uppercase().valid(
    "ALL", "DRAFT", "PENDING", "APPROVED", "REJECTED", "PUBLISHED", "ARCHIVED"
  ).default("ALL"),
  vertical: Joi.string().uppercase().valid("ALL", "GENERAL", "GROCERY", "ELECTRONICS", "CLOTHING").default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
}).required();

export const listInventorySchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  health: Joi.string().uppercase().valid("ALL", "HEALTHY", "LOW", "OUT").default("ALL"),
  warehouseId: uuid.allow("").default(""),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
}).required();

const optionalId = uuid.allow(null, "").default(null);
const optionalDecimal = Joi.number().precision(6).min(0).allow(null).default(null);
const pricingSchema = Joi.object({
  listPrice: Joi.number().precision(4).greater(0).required(),
  salePrice: Joi.number().precision(4).greater(0).required(),
  costPrice: Joi.number().precision(4).min(0).allow(null).default(null)
});
const variantSchema = Joi.object({
  sku: Joi.string().trim().uppercase().min(2).max(100).required(),
  barcode: Joi.string().trim().max(100).allow("").default(""),
  name: Joi.string().trim().max(255).allow("").default(""),
  colorOptionId: optionalId,
  sizeOptionId: optionalId,
  material: Joi.string().trim().max(190).allow("").default(""),
  baseUomId: uuid.required(),
  sellingUomId: uuid.required(),
  packQuantity: Joi.number().precision(6).greater(0).default(1),
  soldByWeight: Joi.boolean().default(false),
  minimumOrderQuantity: Joi.number().precision(6).greater(0).default(1),
  maximumOrderQuantity: optionalDecimal,
  quantityStep: Joi.number().precision(6).greater(0).default(1),
  estimatedWeight: optionalDecimal,
  minimumWeight: optionalDecimal,
  maximumWeight: optionalDecimal,
  weightStep: optionalDecimal,
  warrantyMonths: Joi.number().integer().min(0).max(240).allow(null).default(null),
  warrantyType: Joi.string().uppercase().valid("MANUFACTURER", "SELLER", "EXTENDED").allow(null, "").default(null),
  pricing: pricingSchema.optional()
});

const customFieldSchema = Joi.object({
  label: Joi.string().trim().min(1).max(120).required(),
  type: Joi.string().uppercase().valid("TEXT", "NUMBER", "BOOLEAN", "DATE").required(),
  value: Joi.any().required()
}).custom((field, helpers) => {
  if (field.type === "TEXT") {
    if (typeof field.value !== "string" || !field.value.trim() || field.value.trim().length > 2000) {
      return helpers.error("custom.text");
    }
    return { ...field, value: field.value.trim() };
  }
  if (field.type === "NUMBER") {
    if (field.value === null || field.value === ""
      || (typeof field.value === "string" && !field.value.trim())) return helpers.error("custom.number");
    const value = Number(field.value);
    if (!Number.isFinite(value)) return helpers.error("custom.number");
    return { ...field, value };
  }
  if (field.type === "BOOLEAN") {
    if (typeof field.value !== "boolean") return helpers.error("custom.boolean");
    return field;
  }
  const date = typeof field.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(field.value)
    ? new Date(`${field.value}T00:00:00.000Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== field.value) {
    return helpers.error("custom.date");
  }
  return field;
}).messages({
  "custom.text": "Custom field text must contain 1 to 2000 characters.",
  "custom.number": "Custom field number must be a valid number.",
  "custom.boolean": "Custom field yes/no value must be true or false.",
  "custom.date": "Custom field date must use YYYY-MM-DD."
});

const customFieldsSchema = Joi.array().items(customFieldSchema).max(30).custom((fields, helpers) => {
  const labels = fields.map((field) => field.label.toLocaleLowerCase("en-IN"));
  return new Set(labels).size === labels.length ? fields : helpers.error("custom.uniqueLabels");
}).messages({ "custom.uniqueLabels": "Custom field names must be unique." });

export const createProductSchema = Joi.object({
  productCode: Joi.string().trim().uppercase().pattern(/^[A-Z0-9][A-Z0-9_-]*$/).min(2).max(60).required(),
  name: Joi.string().trim().min(2).max(255).required(),
  productKind: Joi.string().uppercase().valid("STANDARD", "BUNDLE").default("STANDARD"),
  vertical: Joi.string().uppercase().valid("GENERAL", "GROCERY", "ELECTRONICS", "CLOTHING").required(),
  brandId: optionalId,
  categoryId: optionalId,
  taxCategoryId: optionalId,
  imageUrls: Joi.array().items(Joi.string().trim().uri({ scheme: ["http", "https"] }).max(500)).unique().max(6).default([]),
  shortDescription: Joi.string().trim().max(2000).allow("").default(""),
  hsnSacCode: Joi.string().trim().max(20).allow("").default(""),
  countryOfOrigin: Joi.string().trim().uppercase().length(2).default("IN"),
  manufacturerName: Joi.string().trim().max(190).allow("").default(""),
  ingredients: Joi.string().trim().max(2000).allow("").default(""),
  storageInstructions: Joi.string().trim().max(1000).allow("").default(""),
  allowSubstitutions: Joi.boolean().default(false),
  modelNumber: Joi.string().trim().max(120).allow("").default(""),
  gender: Joi.string().uppercase().valid("MEN", "WOMEN", "UNISEX", "KIDS").allow("").default(""),
  customFields: customFieldsSchema.default([]),
  isReturnable: Joi.boolean().default(true),
  returnWindowDays: Joi.number().integer().min(0).max(365).allow(null).default(7),
  variant: variantSchema,
  variants: Joi.array().items(variantSchema).min(1).max(100)
}).xor("variant", "variants").required();

export const productItemSchema = Joi.object({
  productId: uuid.required()
}).required();

export const productMediaItemSchema = Joi.object({ productId: uuid.required(), mediaId: uuid.required() }).required();
export const createProductMediaSchema = Joi.object({
  url: Joi.string().trim().uri({ scheme: ["http", "https"] }).max(500).required(),
  altText: Joi.string().trim().max(500).allow("").default(""),
  variantId: uuid.allow(null, "").default(null),
  colorOptionId: uuid.allow(null, "").default(null)
}).custom((value, helpers) => value.variantId && value.colorOptionId
  ? helpers.error("media.scope") : value)
  .messages({ "media.scope": "Choose either a colour gallery or an exact variant gallery, not both." })
  .required();
export const updateProductMediaSchema = Joi.object({
  url: Joi.string().trim().uri({ scheme: ["http", "https"] }).max(500).required(),
  altText: Joi.string().trim().max(500).allow("").default(""),
  variantId: uuid.allow(null, "").default(null),
  colorOptionId: uuid.allow(null, "").default(null)
}).custom((value, helpers) => value.variantId && value.colorOptionId
  ? helpers.error("media.scope") : value)
  .messages({ "media.scope": "Choose either a colour gallery or an exact variant gallery, not both." })
  .required();
export const uploadProductMediaSchema = Joi.object({
  fileName: Joi.string().trim().max(255).required(),
  altText: Joi.string().trim().max(500).allow("").default(""),
  variantId: uuid.allow(null, "").default(null),
  colorOptionId: uuid.allow(null, "").default(null)
}).custom((value, helpers) => value.variantId && value.colorOptionId
  ? helpers.error("media.scope") : value)
  .messages({ "media.scope": "Choose either a colour gallery or an exact variant gallery, not both." })
  .required();
export const reorderProductMediaSchema = Joi.object({
  mediaIds: Joi.array().items(uuid.required()).min(1).max(100).unique().required()
}).required();

export const productApprovalSchema = Joi.object({
  note: Joi.string().trim().max(500).allow("").default("")
}).default({});

export const productRejectionSchema = Joi.object({
  note: Joi.string().trim().min(10).max(500).required()
}).required();

export const updateProductSchema = Joi.object({
  name: Joi.string().trim().min(2).max(255).required(),
  brandId: optionalId,
  categoryId: optionalId,
  taxCategoryId: optionalId,
  imageUrls: Joi.array().items(Joi.string().trim().uri({ scheme: ["http", "https"] }).max(500)).unique().max(6).default([]),
  shortDescription: Joi.string().trim().max(2000).allow("").default(""),
  hsnSacCode: Joi.string().trim().max(20).allow("").default(""),
  countryOfOrigin: Joi.string().trim().uppercase().length(2).default("IN"),
  manufacturerName: Joi.string().trim().max(190).allow("").default(""),
  ingredients: Joi.string().trim().max(2000).allow("").default(""),
  storageInstructions: Joi.string().trim().max(1000).allow("").default(""),
  allowSubstitutions: Joi.boolean().default(false),
  modelNumber: Joi.string().trim().max(120).allow("").default(""),
  gender: Joi.string().uppercase().valid("MEN", "WOMEN", "UNISEX", "KIDS").allow("").default(""),
  customFields: customFieldsSchema.optional(),
  isReturnable: Joi.boolean().default(true),
  returnWindowDays: Joi.number().integer().min(0).max(365).allow(null).default(7)
}).required();

export const updateProductPricesSchema = Joi.object({
  prices: Joi.array().items(Joi.object({
    variantId: uuid.required(),
    listPrice: Joi.number().precision(4).greater(0).required(),
    salePrice: Joi.number().precision(4).greater(0).required(),
    costPrice: Joi.number().precision(4).min(0).allow(null).default(null)
  })).min(1).max(100).unique("variantId").required()
}).required();

export const masterTypeSchema = Joi.object({
  masterType: Joi.string().valid("categories", "brands", "colors", "sizes").required()
}).required();

export const masterItemSchema = Joi.object({
  masterType: Joi.string().valid("categories", "brands", "colors", "sizes").required(),
  itemId: uuid.required()
}).required();

export const listMastersSchema = Joi.object({
  search: Joi.string().trim().max(190).allow("").default(""),
  status: Joi.string().uppercase().valid("ALL", "ACTIVE", "INACTIVE").default("ALL")
}).required();

export const createMasterSchema = Joi.object({
  name: Joi.string().trim().min(1).max(190).required(),
  parentId: optionalId,
  swatchValue: Joi.string().trim().pattern(/^#[0-9a-fA-F]{6}$/).allow("").default("")
}).required();

export const updateMasterSchema = Joi.object({
  name: Joi.string().trim().min(1).max(190),
  status: Joi.string().uppercase().valid("ACTIVE", "INACTIVE"),
  swatchValue: Joi.string().trim().pattern(/^#[0-9a-fA-F]{6}$/).allow("")
}).min(1).required();

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
