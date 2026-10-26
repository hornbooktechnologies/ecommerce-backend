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
    async uploadLogo(req, res) { res.json({ data: await service.uploadVendorLogo(tenantId(req),
      req.validated.params.vendorId, { buffer: req.body, mimeType: req.get("content-type"),
        originalName: req.validated.query.fileName }, actorContext(req)) }); },
    async uploadDocument(req, res) { res.status(201).json({ data: await service.uploadVendorDocument(
      tenantId(req), req.validated.params.vendorId, req.validated.query,
      { buffer: req.body, mimeType: req.get("content-type"), originalName: req.validated.query.fileName },
      actorContext(req)) }); },
    async downloadDocument(req, res) {
      const file = await service.downloadVendorDocument(tenantId(req), req.validated.params.vendorId,
        req.validated.params.documentId);
      res.set({ "Content-Type": file.mimeType, "Content-Length": String(file.buffer.length),
        "Content-Disposition": `attachment; filename="${file.fileName}"`, "Cache-Control": "private, no-store" });
      res.send(file.buffer);
    },
    async decideDocument(req, res) { res.json({ data: await service.decideVendorDocument(tenantId(req),
      req.validated.params.vendorId, req.validated.params.documentId, req.validated.body,
      actorContext(req)) }); },
    async approve(req, res) { res.json({ data: await service.approveVendor(tenantId(req), req.validated.params.vendorId, req.validated.body, actorContext(req)) }); },
    async suspend(req, res) { res.json({ data: await service.suspendVendor(tenantId(req), req.validated.params.vendorId, req.validated.body, actorContext(req)) }); },
    async restore(req, res) { res.json({ data: await service.restoreVendor(tenantId(req), req.validated.params.vendorId, req.validated.body, actorContext(req)) }); },
    async inviteUser(req, res) { res.status(201).json({ data: await service.inviteVendorUser(tenantId(req), req.validated.params.vendorId, req.validated.body, actorContext(req)) }); },
    async createOffer(req, res) { res.status(201).json({ data: await service.createVendorOffer(tenantId(req), req.validated.params.vendorId, req.validated.body, actorContext(req)) }); },
    async updateOffer(req, res) { res.json({ data: await service.updateVendorOffer(tenantId(req), req.validated.params.vendorId, req.validated.params.offerId, req.validated.body, actorContext(req)) }); }
  };
}
