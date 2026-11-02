import Joi from 'joi';
import {AppError} from '../../core/errors/app-error.js';
export const uuid=Joi.string().guid({version:['uuidv4','uuidv5','uuidv7']}).lowercase().required();
export const uploadQuery=Joi.object({alt:Joi.string().trim().min(1).max(190).default('Customer product photo')});
export const removal=Joi.object({version:Joi.number().integer().min(1).required()});
export const moderation=Joi.object({version:Joi.number().integer().min(1).required(),status:Joi.string().valid('APPROVED','HIDDEN','REJECTED').required(),note:Joi.string().trim().max(1000).allow('').default('')}).custom((value,helpers)=>value.status!=='APPROVED'&&value.note.length<3?helpers.error('any.invalid'):value);
export function validate(schema,input){const {value,error}=schema.validate(input,{abortEarly:false});if(error)throw new AppError({code:'VALIDATION_FAILED',message:'Check photo fields. Hiding or rejecting a photo requires a reason.',status:422,details:error.details.map(d=>({field:d.path.join('.'),message:d.message}))});return value;}
export function sendPhoto(res,buffer){res.set({'Content-Type':'image/webp','Cache-Control':'private, no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-site'}).send(buffer);}
