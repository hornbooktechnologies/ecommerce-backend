import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import * as defaultService from "./warranties.service.js";
import { createWarrantiesController } from "./warranties.controller.js";
import { assignClaimSchema, claimIdSchema, closeClaimSchema, createClaimSchema, diagnoseClaimSchema,
  listClaimsSchema, listWarrantiesSchema, resolveClaimSchema, validateBody, validateParams,
  validateQuery, warrantyIdSchema } from "./warranties.validators.js";

export function createWarrantiesRouter({ warrantiesService = defaultService,
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router();
  const controller = createWarrantiesController(warrantiesService);
  router.use(authenticate, resolveTenant);
  router.get("/warranties/options", authorize("warranty.manage"), controller.options);
  router.get("/warranties", authorize("warranty.read"), validateQuery(listWarrantiesSchema), controller.listWarranties);
  router.get("/warranties/:warrantyId", authorize("warranty.read"), validateParams(warrantyIdSchema), controller.getWarranty);
  router.get("/warranty-claims", authorize("warranty.read"), validateQuery(listClaimsSchema), controller.listClaims);
  router.post("/warranty-claims", authorize("warranty.manage"), validateBody(createClaimSchema), controller.createClaim);
  router.get("/warranty-claims/:claimId", authorize("warranty.read"), validateParams(claimIdSchema), controller.getClaim);
  router.post("/warranty-claims/:claimId/assign", authorize("warranty.manage"), validateParams(claimIdSchema), validateBody(assignClaimSchema), controller.assignClaim);
  router.post("/warranty-claims/:claimId/diagnose", authorize("warranty.manage"), validateParams(claimIdSchema), validateBody(diagnoseClaimSchema), controller.diagnoseClaim);
  router.post("/warranty-claims/:claimId/resolve", authorize("warranty.manage"), validateParams(claimIdSchema), validateBody(resolveClaimSchema), controller.resolveClaim);
  router.post("/warranty-claims/:claimId/close", authorize("warranty.manage"), validateParams(claimIdSchema), validateBody(closeClaimSchema), controller.closeClaim);
  return router;
}
