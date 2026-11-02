import {Router} from 'express';
import Joi from 'joi';
import {AppError} from '../../core/errors/app-error.js';
import * as service from './specifications.service.js';
const uuid=Joi.string().guid({version:['uuidv4','uuidv5','uuidv7']}).lowercase();
const vertical=Joi.string().valid('GENERAL','GROCERY','ELECTRONICS','CLOTHING');
const document=Joi.object({code:Joi.string().trim().uppercase().pattern(/^[A-Z][A-Z0-9_]{1,59}$/).required(),name:Joi.string().trim().min(1).max(120).required(),vertical:vertical.required(),categoryId:uuid.allow(null).default(null),dataType:Joi.string().valid('TEXT','NUMBER','BOOLEAN','DATE','SELECT').required(),unit:Joi.string().trim().max(30).allow('').default(''),group:Joi.string().trim().min(1).max(80).default('Details'),helpText:Joi.string().trim().max(500).allow('').default(''),options:Joi.array().items(Joi.string().trim().min(1).max(120)).unique((a,b)=>a.toLowerCase()===b.toLowerCase()).max(50).default([]),customerVisible:Joi.boolean().strict().required(),sortOrder:Joi.number().integer().min(0).max(9999).default(0),status:Joi.string().valid('ACTIVE','INACTIVE').required()}).custom((value,helpers)=>{
 if((value.dataType==='SELECT'&&!value.options.length)||(value.dataType!=='SELECT'&&value.options.length)||(value.dataType!=='NUMBER'&&value.unit))return helpers.error('any.invalid');return value;
});
function validate(schema,input){const {error,value}=schema.validate(input,{abortEarly:false});if(error)throw new AppError({code:'VALIDATION_FAILED',message:'Check specification fields. Choice fields need unique options; only number fields accept a unit.',status:422,details:error.details.map(d=>({field:d.path.join('.'),message:d.message}))});return value;}
export function createSpecificationsRouter({authorize}){
 const router=Router(),tenant=req=>req.context.tenant.tenantId,context=req=>({actorUserId:req.context.actor.userId,requestId:req.context.requestId,ipAddress:req.ip,userAgent:req.get('user-agent')});
 router.get('/specifications',authorize('catalog.product.read'),async(req,res)=>res.json({data:await service.list(tenant(req),validate(Joi.object({search:Joi.string().trim().max(190).allow('').default(''),status:Joi.string().valid('ALL','ACTIVE','INACTIVE').default('ALL'),vertical:vertical.valid('ALL').default('ALL'),page:Joi.number().integer().min(1).max(10000).default(1),pageSize:Joi.number().integer().min(1).max(100).default(10)}),req.query))}));
 router.post('/specifications',authorize('catalog.product.create'),async(req,res)=>res.status(201).json({data:await service.save(tenant(req),null,validate(document,req.body),context(req))}));
 router.put('/specifications/:definitionId',authorize('catalog.product.update'),async(req,res)=>res.json({data:await service.save(tenant(req),validate(uuid.required(),req.params.definitionId),validate(document.keys({version:Joi.number().integer().min(1).required()}),req.body),context(req))}));
 router.get('/products/:productId/specifications',authorize('catalog.product.read'),async(req,res)=>res.json({data:await service.assignment(tenant(req),validate(uuid.required(),req.params.productId))}));
 router.put('/products/:productId/specifications',authorize('catalog.product.update'),async(req,res)=>res.json({data:await service.assign(tenant(req),validate(uuid.required(),req.params.productId),validate(Joi.object({version:Joi.number().integer().min(0).required(),definitionRevision:Joi.string().hex().length(64).required(),values:Joi.array().items(Joi.object({definitionId:uuid.required(),value:Joi.any().invalid(null).required()})).unique('definitionId').max(500).required()}),req.body),context(req))}));
 return router;
}
