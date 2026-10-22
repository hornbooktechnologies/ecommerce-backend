import { Router } from "express";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { authenticate } from "../auth/auth.middleware.js";
import * as defaultService from "./substitutions.service.js";
import { createSubstitutionsController } from "./substitutions.controller.js";
import { createRuleSchema, listRulesSchema, listVariantsSchema, ruleIdSchema, updateRuleSchema,
  validateBody, validateParams, validateQuery } from "./substitutions.validators.js";

export function createSubstitutionsRouter({ substitutionsService = defaultService,
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router(); const controller = createSubstitutionsController(substitutionsService);
  router.use(authenticate, resolveTenant);
  router.get("/catalog/substitutions/variants", authorize("catalog.product.read"), validateQuery(listVariantsSchema), controller.variants);
  router.get("/catalog/substitutions", authorize("catalog.product.read"), validateQuery(listRulesSchema), controller.list);
  router.post("/catalog/substitutions", authorize("catalog.product.update"), validateBody(createRuleSchema), controller.create);
  router.patch("/catalog/substitutions/:ruleId", authorize("catalog.product.update"), validateParams(ruleIdSchema), validateBody(updateRuleSchema), controller.update);
  router.delete("/catalog/substitutions/:ruleId", authorize("catalog.product.update"), validateParams(ruleIdSchema), controller.remove);
  return router;
}
