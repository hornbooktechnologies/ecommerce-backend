import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePlatformPermission } from "./platform-authorization.middleware.js";
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
  authorizePlatform
} = {}) {
  const router = Router();
  const controller = createPlatformTenantController(tenantService);

  const guard = (permission) => authorizePlatform || requirePlatformPermission(permission);
  router.use(authenticate);
  router.get("/", guard("platform.tenant.read"), validateQuery(listTenantsSchema), controller.list);
  router.post("/", guard("platform.tenant.create"), validateBody(createTenantSchema), controller.create);
  router.get("/:tenantId", guard("platform.tenant.read"), validateParams(tenantIdSchema), controller.get);
  router.patch(
    "/:tenantId",
    guard("platform.tenant.update"),
    validateParams(tenantIdSchema),
    validateBody(updateTenantSchema),
    controller.update
  );
  router.post(
    "/:tenantId/activate",
    guard("platform.tenant.lifecycle"),
    validateParams(tenantIdSchema),
    validateBody(transitionTenantSchema),
    controller.activate
  );
  router.post(
    "/:tenantId/suspend",
    guard("platform.tenant.lifecycle"),
    validateParams(tenantIdSchema),
    validateBody(transitionTenantSchema),
    controller.suspend
  );
  router.post(
    "/:tenantId/restore",
    guard("platform.tenant.lifecycle"),
    validateParams(tenantIdSchema),
    validateBody(transitionTenantSchema),
    controller.restore
  );

  return router;
}
