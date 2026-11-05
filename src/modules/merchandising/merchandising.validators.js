import Joi from 'joi';
export const scopeSchema = Joi.object({
  tenantCode: Joi.string()
    .pattern(/^[A-Za-z0-9_-]{1,60}$/)
    .required(),
  storeCode: Joi.string()
    .pattern(/^[A-Za-z0-9_-]{1,60}$/)
    .required(),
});
export const consentSchema = Joi.object({
  enabled: Joi.boolean().strict().required(),
  consent: Joi.boolean()
    .strict()
    .when('enabled', {
      is: true,
      then: Joi.valid(true).required(),
      otherwise: Joi.valid(false).default(false),
    }),
});
export const eventSchema = Joi.object({
  kind: Joi.string().valid('VIEW', 'OPEN', 'CLICK').required(),
  sourceKind: Joi.string()
    .valid('COLLECTION', 'HERO', 'BANNER', 'SHELF')
    .required(),
  sourceKey: Joi.string()
    .pattern(/^[A-Za-z0-9_-]{1,160}$/)
    .required(),
  productSlug: Joi.string()
    .pattern(/^[a-zA-Z0-9_-]{1,320}$/)
    .when('kind', {
      is: 'CLICK',
      then: Joi.required(),
      otherwise: Joi.forbidden(),
    }),
});
const day = Joi.string()
  .isoDate()
  .strict()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .custom((value, helpers) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value &&
      Number(value.slice(0, 4)) >= 1000
      ? value
      : helpers.error('any.invalid');
  })
  .required();
export const reportSchema = Joi.object({
  fromDate: day,
  toDate: day,
  kind: Joi.string()
    .valid('ALL', 'COLLECTION', 'HERO', 'BANNER', 'SHELF')
    .default('ALL'),
  search: Joi.string().trim().max(120).allow('').default(''),
  page: Joi.number().integer().min(1).max(10000).default(1),
  pageSize: Joi.number().integer().valid(10, 20, 50).default(10),
}).custom((value, helpers) =>
  Date.parse(value.fromDate) > Date.parse(value.toDate) ||
  (Date.parse(value.toDate) - Date.parse(value.fromDate)) / 86400000 > 91
    ? helpers.error('any.invalid')
    : value,
);
