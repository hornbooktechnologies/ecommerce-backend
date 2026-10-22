import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { authorizePlatform as defaultAuthorizePlatform } from "./platform-authorization.middleware.js";
import { createPlatformTenantController } from "./platform-tenants.controller.js";
import * as defaultTenantService from "./platform-tenants.service.js";
import {
  createTenantSchema,
  listTenantsSchema,
  tenantIdSchema,
  transitionTenantSchema,
  updateTenantSchema,
  validateBody,
  validateParams,
  validateQuery
} from "./platform-tenants.validators.js";

export function createPlatformTenantRouter({
  tenantService = defaultTenantService,
  authorizePlatform = defaultAuthorizePlatform
} = {}) {
  const router = Router();
  const controller = createPlatformTenantController(tenantService);

  router.use(authenticate, authorizePlatform);
  router.get("/", validateQuery(listTenantsSchema), controller.list);
  router.post("/", validateBody(createTenantSchema), controller.create);
  router.get("/:tenantId", validateParams(tenantIdSchema), controller.get);
  router.patch(
    "/:tenantId",
    validateParams(tenantIdSchema),
    validateBody(updateTenantSchema),
    controller.update
  );
  router.post(
    "/:tenantId/activate",
    validateParams(tenantIdSchema),
    validateBody(transitionTenantSchema),
    controller.activate
  );
  router.post(
    "/:tenantId/suspend",
    validateParams(tenantIdSchema),
    validateBody(transitionTenantSchema),
    controller.suspend
  );
  router.post(
    "/:tenantId/restore",
    validateParams(tenantIdSchema),
    validateBody(transitionTenantSchema),
    controller.restore
  );

  return router;
}
