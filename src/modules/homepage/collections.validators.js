import Joi from 'joi';
export const collectionSlug = Joi.string()
  .pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(120);
const text = (max) => Joi.string().trim().max(max).allow('').required();
const time = Joi.string()
  .isoDate()
  .strict()
  .pattern(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  .allow(null)
  .default(null);
export const collectionDocument = Joi.object({
  title: Joi.string().trim().min(1).max(120).required(),
  description: text(1000),
  imageUrl: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .max(2048)
    .allow('')
    .required(),
  altText: text(180),
  seoTitle: text(70),
  seoDescription: text(180),
  rule: Joi.string()
    .valid('NEWEST', 'DISCOUNT', 'REVIEWS', 'MANUAL')
    .required(),
  productSlugs: Joi.array()
    .items(Joi.string().pattern(/^[a-zA-Z0-9_-]{1,320}$/))
    .unique()
    .max(100)
    .required(),
  brandId: Joi.string().guid().lowercase().allow(null).default(null),
  categoryId: Joi.string().guid().lowercase().allow(null).default(null),
  inStockOnly: Joi.boolean().strict().default(false),
  startsAt: time,
  endsAt: time,
})
  .custom((value, helpers) =>
    value.startsAt &&
    value.endsAt &&
    Date.parse(value.startsAt) >= Date.parse(value.endsAt)
      ? helpers.error('any.invalid')
      : value,
  )
  .required();
export const collectionCreate = Joi.object({
  slug: collectionSlug.required(),
  document: collectionDocument,
});
export const collectionSave = Joi.object({
  revision: Joi.number().integer().min(1).required(),
  document: collectionDocument,
});
export const collectionRevision = Joi.object({
  revision: Joi.number().integer().min(1).required(),
});
export const collectionParams = Joi.object({
  storeId: Joi.string().guid().required(),
  collectionId: Joi.string().guid().required(),
});
export const collectionList = Joi.object({
  search: Joi.string().trim().max(120).allow('').default(''),
  page: Joi.number().integer().min(1).max(10000).default(1),
  pageSize: Joi.number().integer().valid(10, 20, 50).default(10),
});
export const collectionProducts = Joi.object({
  search: Joi.string().trim().max(190).allow('').default(''),
  sort: Joi.string()
    .valid('curated', 'newest', 'price_asc', 'price_desc', 'rating', 'discount')
    .default('curated'),
  page: Joi.number().integer().min(1).max(10000).default(1),
  pageSize: Joi.number().integer().min(1).max(50).default(10),
});
