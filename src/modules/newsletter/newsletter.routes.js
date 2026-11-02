import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { createNewsletterService } from "./newsletter.service.js";
import { schemas, validate } from "./newsletter.validators.js";

export function createPublicNewsletterRouter({ service = createNewsletterService() } = {}) {
  const router = Router(); const base = "/:tenantCode/stores/:storeCode/newsletter";
  for (const action of ["subscribe", "confirm", "unsubscribe"]) {
    router.post(`${base}/${action}`, async (req, res) => {
      res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
      const params = validate(schemas.scope, req.params);
      const input = validate(action === "subscribe" ? schemas.subscribe : schemas.token, req.body);
      const scope = await service.scope(params, action === "unsubscribe");
      await service.ipLimit(scope, req.ip);
      res.status(action === "subscribe" ? 202 : 200).json({ data: await service[action](scope, input) });
    });
  }
  return router;
}
export function createAdminNewsletterRouter({ service = createNewsletterService(),
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router(); router.use("/newsletter", authenticate, resolveTenant, (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }); next();
  });
  router.get("/newsletter/subscribers", authorize("newsletter.read"), async (req, res) => {
    res.json({ data: await service.list(req.context.tenant.tenantId, validate(schemas.list, req.query)) });
  });
  router.post("/newsletter/subscribers/:subscriberId/unsubscribe", authorize("newsletter.read"), authorize("newsletter.manage"), async (req, res) => {
    const { subscriberId } = validate(schemas.subscriber, req.params);
    res.json({ data: await service.adminUnsubscribe(req.context.tenant.tenantId, subscriberId, validate(schemas.unsubscribe, req.body),
      { actorUserId: req.context.actor.userId, requestId: req.context.requestId }) });
  });
  return router;
}
