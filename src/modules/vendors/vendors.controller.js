import * as defaultService from "./vendors.service.js";

function actorContext(req) {
  return { actorUserId: req.context.actor.userId, requestId: req.context.requestId,
    ipAddress: req.ip, userAgent: req.get("user-agent") || null };
}

export function createVendorsController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async options(req, res) { res.json({ data: await service.listVendorOptions(tenantId(req), req.validated.query) }); },
    async list(req, res) { res.json({ data: await service.listVendors(tenantId(req), req.validated.query) }); },
    async get(req, res) { res.json({ data: await service.getVendor(tenantId(req), req.validated.params.vendorId) }); },
    async create(req, res) { res.status(201).json({ data: await service.createVendor(tenantId(req), req.validated.body, actorContext(req)) }); },
    async update(req, res) { res.json({ data: await service.updateVendor(tenantId(req), req.validated.params.vendorId, req.validated.body, actorContext(req)) }); },
    async approve(req, res) { res.json({ data: await service.approveVendor(tenantId(req), req.validated.params.vendorId, req.validated.body, actorContext(req)) }); },
    async suspend(req, res) { res.json({ data: await service.suspendVendor(tenantId(req), req.validated.params.vendorId, req.validated.body, actorContext(req)) }); },
    async restore(req, res) { res.json({ data: await service.restoreVendor(tenantId(req), req.validated.params.vendorId, req.validated.body, actorContext(req)) }); },
    async inviteUser(req, res) { res.status(201).json({ data: await service.inviteVendorUser(tenantId(req), req.validated.params.vendorId, req.validated.body, actorContext(req)) }); },
    async createOffer(req, res) { res.status(201).json({ data: await service.createVendorOffer(tenantId(req), req.validated.params.vendorId, req.validated.body, actorContext(req)) }); },
    async updateOffer(req, res) { res.json({ data: await service.updateVendorOffer(tenantId(req), req.validated.params.vendorId, req.validated.params.offerId, req.validated.body, actorContext(req)) }); }
  };
}
