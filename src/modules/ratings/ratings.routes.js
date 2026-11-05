import { Router } from "express";
import * as sellerRatings from '../seller-ratings/seller-ratings.service.js';
import * as sellerInput from '../seller-ratings/seller-ratings.validators.js';
import * as photos from '../review-photos/review-photos.service.js';
import * as photoInput from '../review-photos/review-photos.validators.js';
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { authenticate } from "../auth/auth.middleware.js";
import * as defaultService from "./ratings.service.js";
import { createRatingsController } from "./ratings.controller.js";
import { listRatingsSchema, moderateRatingSchema, ratingParamsSchema,
  validateBody, validateParams, validateQuery } from "./ratings.validators.js";

export function createRatingsRouter({ ratingsService = defaultService,
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router(); const controller = createRatingsController(ratingsService);
  router.use(authenticate, resolveTenant);
  router.get('/seller-ratings',authorize('rating.read'),async(req,res)=>res.json({data:await sellerRatings.list(req.context.tenant.tenantId,sellerInput.validate(sellerInput.listing,req.query))}));
  router.post('/seller-ratings/:ratingId/moderate',authorize('rating.read'),authorize('rating.moderate'),async(req,res)=>res.json({data:await sellerRatings.moderate(req.context.tenant.tenantId,sellerInput.validate(sellerInput.uuid.required(),req.params.ratingId),sellerInput.validate(sellerInput.moderation,req.body),{actorUserId:req.context.actor.userId,requestId:req.context.requestId,ipAddress:req.ip,userAgent:req.get('user-agent')||null})}));
  router.get("/ratings/options", authorize("rating.read"), controller.options);
  const ids=req=>({reviewId:photoInput.validate(photoInput.uuid,req.params.ratingId),photoId:req.params.photoId?photoInput.validate(photoInput.uuid,req.params.photoId):undefined});
  router.get('/ratings/:ratingId/photos',authorize('rating.read'),async(req,res)=>res.json({data:await photos.adminList(req.context.tenant.tenantId,ids(req).reviewId)}));
  router.get('/ratings/:ratingId/photos/:photoId/file',authorize('rating.read'),async(req,res)=>{const input=ids(req);photoInput.sendPhoto(res,await photos.adminFile(req.context.tenant.tenantId,input.reviewId,input.photoId));});
  router.post('/ratings/:ratingId/photos/:photoId/moderate',authorize('rating.read'),authorize('rating.moderate'),async(req,res)=>{const input=ids(req);res.json({data:await photos.moderate(req.context.tenant.tenantId,input.reviewId,input.photoId,photoInput.validate(photoInput.moderation,req.body),{actorUserId:req.context.actor.userId})});});
  router.get("/ratings", authorize("rating.read"), validateQuery(listRatingsSchema), controller.list);
  router.get("/ratings/:ratingId", authorize("rating.read"), validateParams(ratingParamsSchema), controller.get);
  router.post("/ratings/:ratingId/moderate", authorize("rating.moderate"),
    validateParams(ratingParamsSchema), validateBody(moderateRatingSchema), controller.moderate);
  return router;
}
