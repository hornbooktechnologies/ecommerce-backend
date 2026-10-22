import * as defaultService from "./offers.service.js";

function actorContext(req) {
  return { actorUserId: req.context.actor.userId, requestId: req.context.requestId,
    ipAddress: req.ip, userAgent: req.get("user-agent") || null };
}

export function createOffersController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async list(req, res) { res.json({ data: await service.listOffers(tenantId(req), req.validated.query) }); },
    async options(req, res) { res.json({ data: await service.listOptions(tenantId(req), req.validated.query) }); },
    async get(req, res) { res.json({ data: await service.getOffer(tenantId(req), req.validated.params.offerId) }); },
    async create(req, res) { res.status(201).json({ data: await service.createOffer(tenantId(req), req.validated.body, actorContext(req)) }); },
    async update(req, res) { res.json({ data: await service.updateOffer(tenantId(req), req.validated.params.offerId, req.validated.body, actorContext(req)) }); },
    async listPriceLists(req, res) { res.json({ data: await service.listPriceLists(tenantId(req)) }); },
    async createPriceList(req, res) { res.status(201).json({ data: await service.createPriceList(tenantId(req), req.validated.body, actorContext(req)) }); },
    async updatePriceList(req, res) { res.json({ data: await service.updatePriceList(tenantId(req), req.validated.params.priceListId, req.validated.body, actorContext(req)) }); }
  };
}
