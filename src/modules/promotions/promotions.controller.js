import * as defaultService from "./promotions.service.js";

function actorContext(req) { return { actorUserId: req.context.actor.userId, requestId: req.context.requestId,
  ipAddress: req.ip, userAgent: req.get("user-agent") || null }; }

export function createPromotionsController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async list(req, res) { res.json({ data: await service.listPromotions(tenantId(req), req.validated.query) }); },
    async options(req, res) { res.json({ data: await service.listOptions(tenantId(req)) }); },
    async get(req, res) { res.json({ data: await service.getPromotion(tenantId(req), req.validated.params.promotionId) }); },
    async create(req, res) { res.status(201).json({ data: await service.createPromotion(tenantId(req), req.validated.body, actorContext(req)) }); },
    async update(req, res) { res.json({ data: await service.updatePromotion(tenantId(req), req.validated.params.promotionId, req.validated.body, actorContext(req)) }); },
    async activate(req, res) { res.json({ data: await service.transitionPromotion(tenantId(req), req.validated.params.promotionId, "ACTIVE", actorContext(req)) }); },
    async pause(req, res) { res.json({ data: await service.transitionPromotion(tenantId(req), req.validated.params.promotionId, "PAUSED", actorContext(req)) }); },
    async createCoupon(req, res) { res.status(201).json({ data: await service.createCoupon(tenantId(req), req.validated.params.promotionId, req.validated.body, actorContext(req)) }); },
    async updateCoupon(req, res) { res.json({ data: await service.updateCoupon(tenantId(req), req.validated.params.promotionId, req.validated.params.couponId, req.validated.body, actorContext(req)) }); },
    async preview(req, res) { res.json({ data: await service.previewPromotion(tenantId(req), req.validated.params.promotionId, req.validated.body) }); }
  };
}
