import {Router} from 'express';
import Joi from 'joi';
import {AppError} from '../../core/errors/app-error.js';
import * as service from './size-guides.service.js';

const uuid=Joi.string().guid({version:['uuidv4','uuidv5','uuidv7']}).lowercase();
const item=Joi.object({guideId:uuid.required()}),product=Joi.object({productId:uuid.required()});
const list=Joi.object({search:Joi.string().trim().max(190).allow('').default(''),status:Joi.string().valid('ALL','ACTIVE','INACTIVE').default('ALL'),page:Joi.number().integer().min(1).max(10000).default(1),pageSize:Joi.number().integer().min(1).max(100).default(10)});
const document=Joi.object({name:Joi.string().trim().min(2).max(190).required(),unit:Joi.string().valid('CM','IN').required(),basis:Joi.string().valid('BODY','GARMENT').required(),description:Joi.string().trim().max(1000).allow('').default(''),instructions:Joi.string().trim().max(4000).allow('').default(''),status:Joi.string().valid('ACTIVE','INACTIVE').required(),
 columns:Joi.array().items(Joi.string().trim().min(1).max(50)).min(1).max(8).required(),rows:Joi.array().items(Joi.object({size:Joi.string().trim().min(1).max(50).required(),values:Joi.array().items(Joi.string().trim().min(1).max(50)).min(1).max(8).required()})).min(1).max(50).required()
}).custom((input,helpers)=>{
 const unique=values=>new Set(values.map(value=>value.toLocaleLowerCase('en-IN'))).size===values.length;
 return !unique(input.columns)||!unique(input.rows.map(row=>row.size))||input.rows.some(row=>row.values.length!==input.columns.length)?helpers.error('any.invalid'):input;
});
function validate(schema,input){const {value,error}=schema.validate(input,{abortEarly:false});if(error)throw new AppError({code:'VALIDATION_FAILED',message:'Check the size guide fields. Every row needs one value per measurement; size and column names must be unique.',status:422,details:error.details.map(d=>({field:d.path.join('.'),message:d.message}))});return value;}
export function createSizeGuidesRouter({authorize}) {
 const router=Router(),tenant=req=>req.context.tenant.tenantId,context=req=>({actorUserId:req.context.actor.userId,requestId:req.context.requestId,ipAddress:req.ip,userAgent:req.get('user-agent')});
 router.get('/size-guides',authorize('catalog.product.read'),async(req,res)=>res.json({data:await service.list(tenant(req),validate(list,req.query))}));
 router.post('/size-guides',authorize('catalog.product.create'),async(req,res)=>res.status(201).json({data:await service.save(tenant(req),null,validate(document,req.body),context(req))}));
 router.get('/size-guides/:guideId',authorize('catalog.product.read'),async(req,res)=>res.json({data:await service.detail(tenant(req),validate(item,req.params).guideId)}));
 router.put('/size-guides/:guideId',authorize('catalog.product.update'),async(req,res)=>res.json({data:await service.save(tenant(req),validate(item,req.params).guideId,validate(document.keys({version:Joi.number().integer().min(1).required()}),req.body),context(req))}));
 router.get('/products/:productId/size-guide',authorize('catalog.product.read'),async(req,res)=>res.json({data:await service.assignment(tenant(req),validate(product,req.params).productId)}));
 router.put('/products/:productId/size-guide',authorize('catalog.product.update'),async(req,res)=>res.json({data:await service.assign(tenant(req),validate(product,req.params).productId,validate(Joi.object({guideId:uuid.allow(null).required(),previousGuideId:uuid.allow(null).required()}),req.body),context(req))}));
 return router;
}
