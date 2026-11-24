import Joi from "joi";

const text = (max) => Joi.string().trim().max(max).allow("").required();
// Only implemented, same-store destinations. Never accept protocol-relative or script URLs.
export const destination = Joi.string().pattern(/^\/(?:|products|collections\/[a-z0-9]+(?:-[a-z0-9]+)*|p\/[a-zA-Z0-9_-]{1,320}|c\/[a-zA-Z0-9_-]{1,260})$/).max(325).required();
const instant = Joi.string().isoDate().strict().pattern(/T.*(?:Z|[+-]\d{2}:\d{2})$/).allow(null);
const saleEvent = Joi.object({ startsAt: instant.required(), endsAt: instant.required() }).custom((value, helpers) =>
  value.startsAt && value.endsAt && Date.parse(value.endsAt) <= Date.parse(value.startsAt)
    ? helpers.message({ custom: "The sale must end after its start time." }) : value);
export const heroDocumentSchema = Joi.object({
  enabled: Joi.boolean().required(),
  autoplay: Joi.boolean().required(),
  intervalSeconds: Joi.number().integer().min(5).max(20).required(),
  slides: Joi.array().max(10).unique("id").items(Joi.object({
    id: Joi.string().guid().required(),
    enabled: Joi.boolean().required(),
    eyebrow: text(80), title: text(120), description: text(300),
    imageUrl: Joi.string().uri({ scheme: ["http", "https"] }).max(2048).allow("").required(),
    altText: text(180),
    productSlug: Joi.string().pattern(/^[a-zA-Z0-9_-]{1,320}$/).allow("").required(),
    href: destination, ctaLabel: Joi.string().trim().min(1).max(40).required(),
    tone: Joi.string().valid("sage", "rose", "sand").required(),
    saleEvent, showPrice: Joi.boolean().required()
  })).required()
}).required();
export const saveHeroSchema = Joi.object({ revision: Joi.number().integer().min(0).required(), document: heroDocumentSchema });
export const publishHeroSchema = Joi.object({ revision: Joi.number().integer().min(1).required() });
