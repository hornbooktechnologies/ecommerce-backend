import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { createStoreContentService } from "./store-content.service.js";
import { schemas, validate } from "./store-content.validators.js";

const noStore = (_req, res, next) => { res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }); next(); };
export function createAdminStoreContentRouter({ service = createStoreContentService(),
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router();
  router.get("/content-pages/stores", authenticate, resolveTenant, authorize("store.content.read"), noStore, async (req, res) => {
    res.json({ data: await service.stores(req.context.tenant.tenantId, validate(schemas.stores, req.query).search) });
  });
  const base = "/stores/:storeId/content-pages/:pageKey";
  router.use(base, authenticate, resolveTenant, authorize("store.content.read"), noStore, (req, _res, next) => {
    req.contentPage = validate(schemas.page, req.params); next();
  });
  const args = (req) => [req.context.tenant.tenantId, req.contentPage.storeId, req.contentPage.pageKey];
  const context = (req) => ({ actorUserId: req.context.actor.userId, requestId: req.context.requestId });
  router.get(base, async (req, res) => res.json({ data: await service.get(...args(req)) }));
  router.put(base, authorize("store.content.manage"), async (req, res) => res.json({ data: await service.save(...args(req), validate(schemas.save, req.body), context(req)) }));
  router.post(`${base}/preview`, async (req, res) => res.json({ data: await service.preview(...args(req), validate(schemas.preview, req.body).document) }));
  router.post(`${base}/publish`, authorize("store.content.publish"), async (req, res) => res.json({ data: await service.publish(...args(req), validate(schemas.publish, req.body), context(req)) }));
  router.post(`${base}/withdraw`, authorize("store.content.publish"), async (req, res) => res.json({ data: await service.withdraw(...args(req), validate(schemas.withdraw, req.body), context(req)) }));
  return router;
}
export function createPublicStoreContentRouter({ service = createStoreContentService() } = {}) {
  const router = Router(); const base = "/:tenantCode/stores/:storeCode/pages";
  router.use(base, noStore, (req, _res, next) => { req.contentScope = validate(schemas.publicScope, req.params); next(); });
  router.get(base, async (req, res) => res.json({ data: await service.publicIndex(req.contentScope) }));
  router.get(`${base}/:slug`, async (req, res) => res.json({ data: await service.publicPage(req.contentScope, validate(schemas.slug, req.params.slug)) }));
  return router;
}
