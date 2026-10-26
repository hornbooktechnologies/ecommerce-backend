import { Router } from "express";
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
  router.get("/ratings/options", authorize("rating.read"), controller.options);
  router.get("/ratings", authorize("rating.read"), validateQuery(listRatingsSchema), controller.list);
  router.get("/ratings/:ratingId", authorize("rating.read"), validateParams(ratingParamsSchema), controller.get);
  router.post("/ratings/:ratingId/moderate", authorize("rating.moderate"),
    validateParams(ratingParamsSchema), validateBody(moderateRatingSchema), controller.moderate);
  return router;
}
