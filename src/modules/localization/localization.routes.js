import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import {
  requirePermission,
  resolveTenantAccess,
} from "../access-control/access-control.middleware.js";
import {
  storeParamsSchema,
  validateParams,
} from "../store-operations/store-operations.validators.js";
import { readSettings, saveSettings } from "./localization.service.js";
export function createLocalizationRouter() {
  const router = Router(),
    base = "/stores/:storeId/localization";
  router.use(base, authenticate, resolveTenantAccess, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get(
    base,
    validateParams(storeParamsSchema),
    requirePermission("settings.store.read"),
    async (req, res) =>
      res.json({
        data: await readSettings(
          req.context.tenant.tenantId,
          req.validated.params.storeId,
        ),
      }),
  );
  router.put(
    base,
    validateParams(storeParamsSchema),
    requirePermission("settings.store.manage"),
    async (req, res) =>
      res.json({
        data: await saveSettings(
          req.context.tenant.tenantId,
          req.validated.params.storeId,
          req.body,
          {
            actorUserId: req.context.actor.userId,
            requestId: req.context.requestId,
          },
        ),
      }),
  );
  return router;
}
