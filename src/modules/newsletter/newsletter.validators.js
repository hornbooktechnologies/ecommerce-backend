import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

export const CONSENT_VERSION = "NEWSLETTER_2026_10_30";
export const schemas = {
  scope: Joi.object({ tenantCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required(),
    storeCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required() }),
  subscribe: Joi.object({ email: Joi.string().trim().lowercase().email({ tlds: { allow: false }, allowUnicode: false })
    .pattern(/^[\x21-\x7E]+$/).max(254).required(), consent: Joi.boolean().strict().valid(true).required() }),
  token: Joi.object({ token: Joi.string().pattern(/^[a-f0-9]{64}$/).required() }),
  list: Joi.object({ search: Joi.string().trim().max(254).allow("").default(""),
    storeId: Joi.string().guid().allow("").default(""),
    status: Joi.string().valid("ALL", "PENDING", "ACTIVE", "UNSUBSCRIBED").default("ALL"),
    page: Joi.number().integer().min(1).max(100000).default(1),
    pageSize: Joi.number().valid(10, 20, 50, 100).default(10) }),
  subscriber: Joi.object({ subscriberId: Joi.string().guid().required() }),
  unsubscribe: Joi.object({ expectedRevision: Joi.number().integer().positive().required(),
    confirmed: Joi.boolean().strict().valid(true).required(), reason: Joi.string().trim().min(3).max(300).required() })
};
export function validate(schema, input) {
  const { value, error } = schema.required().validate(input, { abortEarly: false });
  if (error) throw new AppError({ code: "VALIDATION_FAILED", message: "Check the highlighted fields and try again.", status: 422,
    details: error.details.map((item) => ({ field: item.path.join("."), message: item.message })) });
  return value;
}
