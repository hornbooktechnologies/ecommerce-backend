import Joi from "joi";
import { destination } from "./homepage.validators.js";

const text = (max) => Joi.string().trim().max(max).allow("").required();
const slug = Joi.string().pattern(/^[a-zA-Z0-9_-]{1,320}$/);
const common = { enabled: Joi.boolean().required(), title: text(120), subtitle: text(240) };
const shelf = Joi.object({ ...common,
  key: Joi.string().valid("DEALS", "DISCOVER", "FRESH").required(),
  rule: Joi.string().valid("DISCOUNT", "REVIEWS", "NEWEST", "MANUAL").required(),
  limit: Joi.number().integer().min(1).max(12).required(),
  productSlugs: Joi.array().items(slug).unique().max(12).required(),
  viewAllHref: destination.allow(""), viewAllLabel: text(40)
});
const banner = Joi.object({ ...common, key: Joi.string().valid("BANNER").required(),
  imageUrl: Joi.string().uri({ scheme: ["http", "https"] }).max(2048).allow("").required(),
  altText: text(180), eyebrow: text(80), badgeText: text(60),
  href: destination, ctaLabel: text(40)
});
export const sectionsDocumentSchema = Joi.object({
  sections: Joi.array().length(4).unique("key").items(Joi.alternatives().try(shelf, banner)).required()
}).required();
export const saveSectionsSchema = Joi.object({ revision: Joi.number().integer().min(0).required(), document: sectionsDocumentSchema }).required();
