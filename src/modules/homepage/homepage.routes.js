import { Router, raw } from "express";
import Joi from "joi";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { storeParamsSchema, validateBody, validateParams, validateQuery } from "../store-operations/store-operations.validators.js";
import { createHomepageService } from "./homepage.service.js";
import { saveHeroSchema, publishHeroSchema } from "./homepage.validators.js";
import { createSectionsService } from "./sections.service.js";
import { saveSectionsSchema, sectionsDocumentSchema } from "./sections.validators.js";

export function createHomepageRouter({ service = createHomepageService(), sectionsService = createSectionsService(), resolveTenant = resolveTenantAccess,
  authorize = requirePermission } = {}) {
  const router = Router();
  const base = "/stores/:storeId/homepage-hero";
  const scope = (req) => [req.context.tenant.tenantId, req.validated.params.storeId];
  const context = (req) => ({ actorUserId: req.context.actor.userId, requestId: req.context.requestId,
    ipAddress: req.ip, userAgent: req.get("user-agent") || null });
  router.use(base, authenticate, resolveTenant, validateParams(storeParamsSchema));
  router.get(base, authorize("settings.store.read"), async (req, res) => res.json({ data: await service.get(...scope(req)) }));
  router.get(`${base}/products`, authorize("settings.store.read"),
    validateQuery(Joi.object({ search: Joi.string().trim().max(190).allow("").default(""),
      selectedSlug: Joi.string().pattern(/^[a-zA-Z0-9_-]{1,320}$/).allow("").default("") })),
    async (req, res) => res.json({ data: await service.products(...scope(req), req.validated.query.search, req.validated.query.selectedSlug) }));
  router.put(base, authorize("settings.store.manage"), validateBody(saveHeroSchema),
    async (req, res) => res.json({ data: await service.save(...scope(req), req.validated.body, context(req)) }));
  router.post(`${base}/publish`, authorize("settings.store.manage"), validateBody(publishHeroSchema),
    async (req, res) => res.json({ data: await service.save(...scope(req), req.validated.body, context(req), true) }));
  router.post(`${base}/images`, authorize("settings.store.manage"),
    validateQuery(Joi.object({ fileName: Joi.string().max(255).default("hero-image") })),
    raw({ type: () => true, limit: "8mb" }),
    async (req, res) => res.status(201).json({ data: await service.upload(...scope(req), {
      buffer: req.body, mimeType: req.get("content-type"), originalName: req.validated.query.fileName
    }) }));
  const sectionsBase = "/stores/:storeId/homepage-sections";
  router.use(sectionsBase, authenticate, resolveTenant, validateParams(storeParamsSchema), (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get(sectionsBase, authorize("settings.store.read"), async (req, res) => res.json({ data: await sectionsService.get(...scope(req)) }));
  router.put(sectionsBase, authorize("settings.store.manage"), validateBody(saveSectionsSchema),
    async (req, res) => res.json({ data: await sectionsService.save(...scope(req), req.validated.body, context(req)) }));
  router.post(`${sectionsBase}/publish`, authorize("settings.store.manage"), validateBody(publishHeroSchema),
    async (req, res) => res.json({ data: await sectionsService.save(...scope(req), req.validated.body, context(req), true) }));
  router.post(`${sectionsBase}/preview`, authorize("settings.store.read"), validateBody(sectionsDocumentSchema),
    async (req, res) => res.json({ data: await sectionsService.preview(...scope(req), req.validated.body) }));
  return router;
}
