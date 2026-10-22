function actor(req) { return { actorUserId: req.context.actor.userId, requestId: req.context.requestId,
  ipAddress: req.ip, userAgent: req.get("user-agent") || null }; }
export function createSubstitutionsController(service) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async variants(req, res) { res.json({ data: await service.listVariants(tenantId(req), req.validated.query) }); },
    async list(req, res) { res.json({ data: await service.listRules(tenantId(req), req.validated.query) }); },
    async create(req, res) { res.status(201).json({ data: { rule: await service.createRule(tenantId(req), req.validated.body, actor(req)) } }); },
    async update(req, res) { res.json({ data: { rule: await service.updateRule(tenantId(req), req.validated.params.ruleId, req.validated.body, actor(req)) } }); },
    async remove(req, res) { await service.deleteRule(tenantId(req), req.validated.params.ruleId, actor(req)); res.status(204).send(); }
  };
}
