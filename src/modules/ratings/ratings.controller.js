import * as defaultService from "./ratings.service.js";

function actorContext(req) { return { actorUserId: req.context.actor.userId,
  requestId: req.context.requestId, ipAddress: req.ip, userAgent: req.get("user-agent") || null }; }

export function createRatingsController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async list(req, res) { res.json({ data: await service.listRatings(tenantId(req), req.validated.query) }); },
    async options(req, res) { res.json({ data: await service.listOptions(tenantId(req)) }); },
    async get(req, res) { res.json({ data: await service.getRating(tenantId(req), req.validated.params.ratingId) }); },
    async moderate(req, res) { res.json({ data: await service.moderateRating(tenantId(req),
      req.validated.params.ratingId, req.validated.body, actorContext(req)) }); }
  };
}
