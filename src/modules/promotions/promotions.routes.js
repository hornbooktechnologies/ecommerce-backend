import { Router } from "express";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { authenticate } from "../auth/auth.middleware.js";
import * as defaultService from "./promotions.service.js";
import { createPromotionsController } from "./promotions.controller.js";
import { couponParamsSchema, couponSchema, listPromotionsSchema, previewPromotionSchema, promotionParamsSchema,
  promotionSchema, validateBody, validateParams, validateQuery } from "./promotions.validators.js";

export function createPromotionsRouter({ promotionsService = defaultService,
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router(); const controller = createPromotionsController(promotionsService);
  router.use(authenticate, resolveTenant);
  router.get("/promotions/options", authorize("promotion.read"), controller.options);
  router.get("/promotions", authorize("promotion.read"), validateQuery(listPromotionsSchema), controller.list);
  router.post("/promotions", authorize("promotion.manage"), validateBody(promotionSchema), controller.create);
  router.get("/promotions/:promotionId", authorize("promotion.read"), validateParams(promotionParamsSchema), controller.get);
  router.patch("/promotions/:promotionId", authorize("promotion.manage"), validateParams(promotionParamsSchema), validateBody(promotionSchema), controller.update);
  router.post("/promotions/:promotionId/activate", authorize("promotion.manage"), validateParams(promotionParamsSchema), controller.activate);
  router.post("/promotions/:promotionId/pause", authorize("promotion.manage"), validateParams(promotionParamsSchema), controller.pause);
  router.post("/promotions/:promotionId/preview", authorize("promotion.read"), validateParams(promotionParamsSchema), validateBody(previewPromotionSchema), controller.preview);
  router.post("/promotions/:promotionId/coupons", authorize("promotion.manage"), validateParams(promotionParamsSchema), validateBody(couponSchema), controller.createCoupon);
  router.patch("/promotions/:promotionId/coupons/:couponId", authorize("promotion.manage"), validateParams(couponParamsSchema), validateBody(couponSchema), controller.updateCoupon);
  return router;
}
