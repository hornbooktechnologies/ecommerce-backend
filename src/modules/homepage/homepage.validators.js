import Joi from "joi";

const text = (max) => Joi.string().trim().max(max).allow("").required();
// Only implemented, same-store destinations. Never accept protocol-relative or script URLs.
export const destination = Joi.string().pattern(/^\/(?:|p\/[a-zA-Z0-9_-]{1,320}|c\/[a-zA-Z0-9_-]{1,260})$/).required();
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
    showPrice: Joi.boolean().required()
  })).required()
}).required();
export const saveHeroSchema = Joi.object({ revision: Joi.number().integer().min(0).required(), document: heroDocumentSchema });
export const publishHeroSchema = Joi.object({ revision: Joi.number().integer().min(1).required() });
