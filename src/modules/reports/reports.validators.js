import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

const uuid = Joi.string().guid({ version: ["uuidv4", "uuidv5", "uuidv7"] });
const common = {
  reportType: Joi.string().uppercase().valid("SALES", "INVENTORY", "EXPIRY", "VENDOR", "GST_TCS", "GST_TDS").default("SALES"),
  fromDate: Joi.date().iso().allow(null, "").default(null),
  toDate: Joi.date().iso().allow(null, "").default(null),
  warehouseId: uuid.allow(null, "").default(null),
  merchantId: uuid.allow(null, "").default(null)
};

export const reportQuerySchema = Joi.object({ ...common,
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10)
}).required();
export const reportExportSchema = Joi.object(common).required();

function validationError(validation) {
  return new AppError({ code: "VALIDATION_FAILED", message: "Check the report filters and try again.", status: 422,
    details: validation.details.map((detail) => ({ field: detail.path.join("."), code: detail.type, message: detail.message })) });
}
export function validateQuery(schema) {
  return (req, _res, next) => {
    const { value, error } = schema.validate(req.query, { abortEarly: false, convert: true, stripUnknown: true });
    if (error) return next(validationError(error));
    req.validated = { ...(req.validated || {}), query: value }; next();
  };
}
