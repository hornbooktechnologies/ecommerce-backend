import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

export const pageDefinitions = Object.freeze([
  { key: "ABOUT", slug: "about", label: "About us" },
  { key: "FAQ_EN", slug: "faq-en", label: "Help FAQs · English" },
  { key: "FAQ_HI", slug: "faq-hi", label: "Help FAQs · हिन्दी" },
  { key: "FAQ_GU", slug: "faq-gu", label: "Help FAQs · ગુજરાતી" },
  { key: "CONTACT", slug: "contact", label: "Contact us" },
  { key: "SHIPPING", slug: "shipping", label: "Shipping information" },
  { key: "RETURNS", slug: "returns", label: "Returns & cancellation" },
  { key: "PRIVACY", slug: "privacy", label: "Privacy policy" },
  { key: "TERMS", slug: "terms", label: "Terms & conditions" }
]);
const uuid = Joi.string().guid().required();
const revision = Joi.number().integer().min(0).max(4294967294).required();
export const documentSchema = Joi.object({
  title: Joi.string().trim().min(1).max(120).required(),
  summary: Joi.string().trim().max(500).allow("").default(""),
  body: Joi.string().replace(/\r\n?/g, "\n").trim().max(30000).allow("").required()
}).required();
export const schemas = {
  stores: Joi.object({ search: Joi.string().trim().max(190).allow("").default("") }),
  store: Joi.object({ storeId: uuid }),
  page: Joi.object({ storeId: uuid, pageKey: Joi.string().valid(...pageDefinitions.map((item) => item.key)).required() }),
  save: Joi.object({ revision, document: documentSchema }),
  preview: Joi.object({ document: documentSchema }),
  publish: Joi.object({ revision, reviewed: Joi.boolean().strict().valid(true).required() }),
  withdraw: Joi.object({ revision, confirmed: Joi.boolean().strict().valid(true).required() }),
  publicScope: Joi.object({ tenantCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required(),
    storeCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required() }),
  slug: Joi.string().valid(...pageDefinitions.map((item) => item.slug)).required()
};
export function validate(schema, input) {
  const { value, error } = schema.required().validate(input, { abortEarly: false });
  if (error) throw new AppError({ code: "VALIDATION_FAILED", message: "Check the page fields and confirmation before trying again.", status: 422,
    details: error.details.map((item) => ({ field: item.path.join("."), message: item.message })) });
  return value;
}
