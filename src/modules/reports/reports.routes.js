import { Router } from "express";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { authenticate } from "../auth/auth.middleware.js";
import * as defaultService from "./reports.service.js";
import { createReportsController } from "./reports.controller.js";
import { reportExportSchema, reportQuerySchema, validateQuery } from "./reports.validators.js";

export function createReportsRouter({ reportsService = defaultService,
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router(); const controller = createReportsController(reportsService);
  router.use(authenticate, resolveTenant);
  router.get("/reports", authorize("report.sales.read"), validateQuery(reportQuerySchema), controller.report);
  router.get("/reports/export", authorize("report.sales.read"), validateQuery(reportExportSchema), controller.exportCsv);
  return router;
}
