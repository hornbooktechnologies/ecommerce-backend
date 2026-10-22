import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import * as defaultService from "./bundles.service.js"; import { createBundlesController } from "./bundles.controller.js";
import { bundleSchema, componentSchema, createComponentSchema, listBundlesSchema, listVariantsSchema, updateComponentSchema,
  validateBody, validateParams, validateQuery } from "./bundles.validators.js";
export function createBundlesRouter({ bundlesService = defaultService, resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router(); const controller = createBundlesController(bundlesService); router.use(authenticate, resolveTenant);
  router.get("/catalog/bundles/variants", authorize("catalog.product.read"), validateQuery(listVariantsSchema), controller.variants);
  router.get("/catalog/bundles", authorize("catalog.product.read"), validateQuery(listBundlesSchema), controller.list);
  router.post("/catalog/bundles/:bundleVariantId/components", authorize("catalog.product.update"), validateParams(bundleSchema), validateBody(createComponentSchema), controller.create);
  router.patch("/catalog/bundles/:bundleVariantId/components/:componentId", authorize("catalog.product.update"), validateParams(componentSchema), validateBody(updateComponentSchema), controller.update);
  router.delete("/catalog/bundles/:bundleVariantId/components/:componentId", authorize("catalog.product.update"), validateParams(componentSchema), controller.remove); return router;
}
