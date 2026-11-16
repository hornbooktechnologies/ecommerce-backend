import {Router} from 'express';
import Joi from 'joi';
import * as service from './order-substitutions.service.js';
import {validateBody,validateParams,validateQuery} from './orders.validators.js';
const uuid=Joi.string().guid({version:['uuidv4','uuidv5','uuidv7']});
export function createOrderSubstitutionsRouter({authorize}) {
  const router=Router(),ids=Joi.object({orderId:uuid.required(),itemId:uuid.required()});
  const path='/orders/:orderId/items/:itemId/substitutions';
  router.use(path,(_req,res,next)=>{res.set({'Cache-Control':'no-store',Pragma:'no-cache'});next();});
  router.get(path,authorize('order.manage'),authorize('order.substitute'),validateParams(ids),
    validateQuery(Joi.object({warehouseId:uuid.optional()})),async(req,res)=>{
      res.json({data:await service.options(req.context.tenant.tenantId,req.validated.params.orderId,
        req.validated.params.itemId,req.validated.query.warehouseId)});
    });
  router.post(path,authorize('order.manage'),authorize('order.substitute'),validateParams(ids),validateBody(Joi.object({
    requestKey:uuid.required(),orderVersion:Joi.number().integer().min(0).required(),offerId:uuid.required(),warehouseId:uuid.required(),
    expectedSalePrice:Joi.number().min(0).precision(4).required(),reason:Joi.string().trim().min(8).max(500).required(),
    customerApproved:Joi.boolean().default(false),approvalReference:Joi.string().trim().max(300).allow('').default(''),
    suitabilityConfirmed:Joi.boolean().valid(true).required()
  })),async(req,res)=>{
    const {orderId,itemId}=req.validated.params;
    res.json({data:await service.apply(req.context.tenant.tenantId,orderId,itemId,req.validated.body,
      {actorUserId:req.context.actor.userId,requestId:req.context.requestId,ipAddress:req.ip,userAgent:req.get('user-agent')||null})});
  });
  return router;
}
