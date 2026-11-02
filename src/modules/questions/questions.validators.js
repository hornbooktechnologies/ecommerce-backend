import Joi from 'joi';
import {AppError} from '../../core/errors/app-error.js';
export const uuid=Joi.string().guid({version:['uuidv4','uuidv5','uuidv7']}).lowercase();
export const pagination=Joi.object({page:Joi.number().integer().min(1).max(10000).default(1),pageSize:Joi.number().integer().valid(10,20,50,100).default(10)});
export const askSchema=Joi.object({productSlug:Joi.string().pattern(/^[a-zA-Z0-9_-]{1,320}$/).required(),question:Joi.string().trim().min(10).max(1000).required()});
export const mineSchema=pagination.keys({questionId:uuid});
export const withdrawSchema=Joi.object({questionId:uuid.required(),version:Joi.number().integer().min(1).required()});
export const answerSchema=Joi.object({version:Joi.number().integer().min(1).required(),body:Joi.string().trim().min(10).max(3000).required()});
export const moderateSchema=Joi.object({version:Joi.number().integer().min(1).required(),status:Joi.string().valid('APPROVED','REJECTED','HIDDEN').required(),note:Joi.string().trim().max(1000).allow('').default('')}).custom((value,helpers)=>value.status!=='APPROVED'&&value.note.length<3?helpers.error('any.invalid'):value);
export const answerModerationSchema=Joi.object({version:Joi.number().integer().min(1).required(),status:Joi.string().valid('PUBLISHED','REJECTED').required(),note:Joi.string().trim().max(1000).allow('').default('')}).custom((value,helpers)=>value.status==='REJECTED'&&value.note.length<3?helpers.error('any.invalid'):value);
export function validate(schema,input){const {error,value}=schema.validate(input,{abortEarly:false});if(error)throw new AppError({code:'VALIDATION_FAILED',message:'Check the question or answer fields. Rejection and hiding require a moderation reason.',status:422,details:error.details.map(d=>({field:d.path.join('.'),message:d.message}))});return value;}
