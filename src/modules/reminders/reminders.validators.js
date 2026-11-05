import Joi from 'joi';
export const empty=Joi.object({});
export const consent=Joi.object({kind:Joi.string().valid('CART','WISHLIST').required(),enabled:Joi.boolean().strict().required(),consent:Joi.boolean().strict().required(),version:Joi.number().integer().min(0).required()}).custom((value,helpers)=>value.enabled&&!value.consent?helpers.error('any.invalid'):value);
export const listing=Joi.object({status:Joi.string().valid('ALL','ACTIVE','OFF','EXPIRED').default('ALL'),page:Joi.number().integer().min(1).max(10000).default(1),pageSize:Joi.number().valid(10,20,50,100).default(10)});
