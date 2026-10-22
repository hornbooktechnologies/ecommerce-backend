import { Router } from "express";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { authenticate } from "../auth/auth.middleware.js";
import * as defaultService from "./marketplace-finance.service.js";
import { createMarketplaceFinanceController } from "./marketplace-finance.controller.js";
import { commissionRuleParamsSchema, commissionRuleSchema, financeWorkspaceSchema,
  validateBody, validateParams, validateQuery } from "./marketplace-finance.validators.js";

export function createMarketplaceFinanceRouter({ marketplaceFinanceService = defaultService,
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router(); const controller = createMarketplaceFinanceController(marketplaceFinanceService);
  router.use(authenticate, resolveTenant);
  router.get("/finance", authorize("marketplace.settlement.read"), validateQuery(financeWorkspaceSchema), controller.workspace);
  router.post("/finance/ledger/reconcile", authorize("marketplace.settlement.manage"), controller.reconcile);
  router.post("/finance/commission-rules", authorize("marketplace.settlement.manage"),
    validateBody(commissionRuleSchema), controller.createRule);
  router.patch("/finance/commission-rules/:ruleId", authorize("marketplace.settlement.manage"),
    validateParams(commissionRuleParamsSchema), validateBody(commissionRuleSchema), controller.updateRule);
  return router;
}
