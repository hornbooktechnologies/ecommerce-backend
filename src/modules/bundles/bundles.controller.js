function actor(req) { return { actorUserId: req.context.actor.userId, requestId: req.context.requestId, ipAddress: req.ip, userAgent: req.get("user-agent") || null }; }
export function createBundlesController(service) { const tenantId = (req) => req.context.tenant.tenantId; return {
  async variants(req, res) { res.json({ data: await service.listVariants(tenantId(req), req.validated.query) }); },
  async list(req, res) { res.json({ data: await service.listBundles(tenantId(req), req.validated.query) }); },
  async create(req, res) { res.status(201).json({ data: { component: await service.createComponent(tenantId(req), req.validated.params.bundleVariantId, req.validated.body, actor(req)) } }); },
  async update(req, res) { res.json({ data: { component: await service.updateComponent(tenantId(req), req.validated.params.bundleVariantId, req.validated.params.componentId, req.validated.body, actor(req)) } }); },
  async remove(req, res) { await service.deleteComponent(tenantId(req), req.validated.params.bundleVariantId, req.validated.params.componentId, actor(req)); res.status(204).send(); }
}; }
