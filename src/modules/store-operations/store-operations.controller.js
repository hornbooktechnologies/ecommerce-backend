import * as defaultService from "./store-operations.service.js";

function actorContext(req) {
  return { actorUserId: req.context.actor.userId, requestId: req.context.requestId,
    ipAddress: req.ip, userAgent: req.get("user-agent") || null };
}

export function createStoreOperationsController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async list(req, res) { res.json({ data: await service.listStores(tenantId(req), req.validated.query) }); },
    async get(req, res) { res.json({ data: await service.getStore(tenantId(req), req.validated.params.storeId) }); },
    async create(req, res) { res.status(201).json({ data: await service.createStore(tenantId(req), req.validated.body, actorContext(req)) }); },
    async update(req, res) { res.json({ data: await service.updateStore(tenantId(req), req.validated.params.storeId, req.validated.body, actorContext(req)) }); },
    async createZone(req, res) { res.status(201).json({ data: { zone: await service.createZone(tenantId(req), req.validated.params.storeId, req.validated.body, actorContext(req)) } }); },
    async updateZone(req, res) { res.json({ data: { zone: await service.updateZone(tenantId(req), req.validated.params.storeId, req.validated.params.zoneId, req.validated.body, actorContext(req)) } }); },
    async createTemplate(req, res) { res.status(201).json({ data: { template: await service.createTemplate(tenantId(req), req.validated.params.storeId, req.validated.body, actorContext(req)) } }); },
    async updateTemplate(req, res) { res.json({ data: { template: await service.updateTemplate(tenantId(req), req.validated.params.storeId, req.validated.params.templateId, req.validated.body, actorContext(req)) } }); },
    async generate(req, res) { res.status(201).json({ data: await service.generateSlots(tenantId(req), req.validated.params.storeId, req.validated.body, actorContext(req)) }); },
    async assignWarehouses(req, res) { res.json({ data: await service.assignWarehouses(tenantId(req), req.validated.params.storeId, req.validated.body, actorContext(req)) }); }
  };
}
