import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import * as defaultService from "./dashboard.service.js";
import { createDashboardController } from "./dashboard.controller.js";

export function createDashboardRouter({ dashboardService = defaultService,
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router();
  const controller = createDashboardController(dashboardService);
  router.use(authenticate, resolveTenant);
  router.get("/dashboard", authorize("dashboard.read"), controller.overview);
  return router;
}
