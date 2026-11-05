import Joi from "joi";
import { destination } from "./homepage.validators.js";

const text = (max) => Joi.string().trim().max(max).allow("").required();
const slug = Joi.string().pattern(/^[a-zA-Z0-9_-]{1,320}$/);
const timestamp=Joi.string().isoDate().strict().pattern(/T.*(?:Z|[+-]\d{2}:\d{2})$/).allow(null).default(null);
const common = { enabled: Joi.boolean().required(), title: text(120), subtitle: text(240),startsAt:timestamp,endsAt:timestamp };
const shelf = Joi.object({ ...common,
  key: Joi.string().pattern(/^(?:DEALS|DISCOVER|FRESH|COLLECTION_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i).required(),
  rule: Joi.string().valid("DISCOUNT", "REVIEWS", "NEWEST", "MANUAL").required(),
  collectionId:Joi.string().guid().lowercase().allow(null).default(null),
  limit: Joi.number().integer().min(1).max(12).required(),
  productSlugs: Joi.array().items(slug).unique().max(12).required(),
  brandId:Joi.string().guid().lowercase().allow(null).default(null),categoryId:Joi.string().guid().lowercase().allow(null).default(null),inStockOnly:Joi.boolean().strict().default(false),
  viewAllHref: destination.allow(""), viewAllLabel: text(40)
});
const banner = Joi.object({ ...common, key: Joi.string().valid("BANNER").required(),
  imageUrl: Joi.string().uri({ scheme: ["http", "https"] }).max(2048).allow("").required(),
  altText: text(180), eyebrow: text(80), badgeText: text(60),
  href: destination, ctaLabel: text(40)
});
export const sectionsDocumentSchema = Joi.object({
  sections: Joi.array().min(4).max(12).unique("key").items(Joi.alternatives().try(shelf, banner)).required()
}).custom((document,helpers)=>!['DEALS','DISCOVER','FRESH','BANNER'].every(key=>document.sections.some(section=>section.key===key))||document.sections.some(section=>section.startsAt&&section.endsAt&&Date.parse(section.startsAt)>=Date.parse(section.endsAt))?helpers.error('any.invalid'):document).required();
export const saveSectionsSchema = Joi.object({ revision: Joi.number().integer().min(0).required(), document: sectionsDocumentSchema }).required();
