import * as defaultService from "./marketplace-finance.service.js";

function actorContext(req) {
  return { actorUserId: req.context.actor.userId, requestId: req.context.requestId,
    ipAddress: req.ip, userAgent: req.get("user-agent") || null };
}

export function createMarketplaceFinanceController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async workspace(req, res) { res.json({ data: await service.getWorkspace(tenantId(req), req.validated.query) }); },
    async reconcile(req, res) { res.json({ data: await service.reconcileLedger(tenantId(req), actorContext(req)) }); },
    async createRule(req, res) { res.status(201).json({ data: await service.createRule(tenantId(req), req.validated.body, actorContext(req)) }); },
    async updateRule(req, res) { res.json({ data: await service.updateRule(tenantId(req), req.validated.params.ruleId,
      req.validated.body, actorContext(req)) }); }
  };
}
