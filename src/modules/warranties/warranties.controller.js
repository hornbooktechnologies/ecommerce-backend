import * as defaultService from "./warranties.service.js";

function actorContext(req) {
  return { actorUserId: req.context.actor.userId, requestId: req.context.requestId,
    ipAddress: req.ip, userAgent: req.get("user-agent") || null };
}

export function createWarrantiesController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async options(req, res) { res.json({ data: await service.listWarrantyOptions(tenantId(req)) }); },
    async listWarranties(req, res) { res.json({ data: await service.listWarranties(tenantId(req), req.validated.query) }); },
    async getWarranty(req, res) { res.json({ data: await service.getWarranty(tenantId(req), req.validated.params.warrantyId) }); },
    async listClaims(req, res) { res.json({ data: await service.listClaims(tenantId(req), req.validated.query) }); },
    async getClaim(req, res) { res.json({ data: await service.getClaim(tenantId(req), req.validated.params.claimId) }); },
    async createClaim(req, res) {
      res.status(201).json({ data: await service.createClaim(tenantId(req), req.validated.body, actorContext(req)) });
    },
    async assignClaim(req, res) {
      res.json({ data: await service.assignClaim(tenantId(req), req.validated.params.claimId, req.validated.body, actorContext(req)) });
    },
    async diagnoseClaim(req, res) {
      res.json({ data: await service.diagnoseClaim(tenantId(req), req.validated.params.claimId, req.validated.body, actorContext(req)) });
    },
    async resolveClaim(req, res) {
      res.json({ data: await service.resolveClaim(tenantId(req), req.validated.params.claimId, req.validated.body, actorContext(req)) });
    },
    async closeClaim(req, res) {
      res.json({ data: await service.closeClaim(tenantId(req), req.validated.params.claimId, req.validated.body, actorContext(req)) });
    }
  };
}
