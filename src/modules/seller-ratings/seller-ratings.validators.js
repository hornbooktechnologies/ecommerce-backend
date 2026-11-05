import Joi from 'joi';
import {AppError} from '../../core/errors/app-error.js';
export const uuid=Joi.string().guid({version:['uuidv4','uuidv5','uuidv7']}).lowercase();
export const pagination=Joi.object({page:Joi.number().integer().min(1).max(10000).default(1),pageSize:Joi.number().integer().valid(10,20,50,100).default(10)});
export const listing=pagination.keys({search:Joi.string().trim().max(190).allow('').default(''),status:Joi.string().valid('ALL','PENDING','PUBLISHED','REJECTED','HIDDEN').default('ALL')});
export const order=Joi.object({orderId:uuid.required()});
export const submission=order.keys({sellerOrderId:uuid.required(),rating:Joi.number().integer().min(1).max(5).required(),review:Joi.string().trim().min(10).max(2000).required()});
export const moderation=Joi.object({version:Joi.number().integer().min(1).required(),status:Joi.string().valid('PUBLISHED','REJECTED','HIDDEN').required(),note:Joi.string().trim().max(1000).allow('').default('')}).custom((input,helpers)=>input.status!=='PUBLISHED'&&input.note.length<3?helpers.error('any.invalid'):input);
export function validate(schema,input){const {error,value}=schema.validate(input,{abortEarly:false});if(error)throw new AppError({code:'VALIDATION_FAILED',message:'Check the seller-rating fields. Rejection and hiding require a reason.',status:422,details:error.details.map(item=>({field:item.path.join('.'),message:item.message}))});return value;}
