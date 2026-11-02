import {Router} from 'express';
import Joi from 'joi';
import {authenticate} from '../auth/auth.middleware.js';
import {resolveTenantAccess,requirePermission} from '../access-control/access-control.middleware.js';
import {resolveVendorAccess,requireVendorPermission} from '../vendor-portal/vendor-portal.middleware.js';
import * as service from './questions.service.js';
import {uuid,pagination,answerSchema,moderateSchema,answerModerationSchema,validate} from './questions.validators.js';
export function createQuestionsRouter({vendor=false,resolveAccess=vendor?resolveVendorAccess:resolveTenantAccess,authorize=vendor?requireVendorPermission:requirePermission}={}){
 const router=Router(),guard=Router();guard.use(authenticate,resolveAccess);guard.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 const scope=req=>({tenantId:(vendor?req.context.vendor:req.context.tenant).tenantId,...(vendor?{merchantId:req.context.vendor.merchantId}:{})}),context=req=>({actorUserId:req.context.actor.userId,requestId:req.context.requestId,ipAddress:req.ip,userAgent:req.get('user-agent')}),permission=key=>vendor?`vendor.question.${key}`:`question.${key}`;
 guard.get('/',authorize(permission('read')),async(req,res)=>res.json({data:await service.list(scope(req),validate(pagination.keys({search:Joi.string().trim().max(190).allow('').default(''),view:Joi.string().valid(...(vendor?['ALL','OPEN','ANSWERED']:['ALL','REVIEW','OPEN','ANSWERED'])).default(vendor?'OPEN':'REVIEW')}),req.query))}));
 guard.get('/:questionId',authorize(permission('read')),async(req,res)=>res.json({data:await service.detail(scope(req),validate(uuid.required(),req.params.questionId),validate(pagination,req.query))}));
 guard.post('/:questionId/answers',authorize(permission('read')),authorize(permission('answer')),async(req,res)=>res.status(201).json({data:await service.answer(scope(req),validate(uuid.required(),req.params.questionId),validate(answerSchema,req.body),context(req))}));
 if(!vendor){
  guard.post('/:questionId/moderate',authorize('question.read'),authorize('question.moderate'),async(req,res)=>res.json({data:await service.moderate(scope(req),validate(uuid.required(),req.params.questionId),validate(moderateSchema,req.body),context(req))}));
  guard.post('/:questionId/answers/:answerId/moderate',authorize('question.read'),authorize('question.moderate'),async(req,res)=>res.json({data:await service.moderateAnswer(scope(req),validate(uuid.required(),req.params.questionId),validate(uuid.required(),req.params.answerId),validate(answerModerationSchema,req.body),context(req))}));
 }
 router.use('/questions',guard);return router;
}
