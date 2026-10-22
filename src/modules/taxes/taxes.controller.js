import * as defaultService from "./taxes.service.js";

function actorContext(req) {
  return { actorUserId: req.context.actor.userId, requestId: req.context.requestId,
    ipAddress: req.ip, userAgent: req.get("user-agent") || null };
}

export function createTaxesController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async getWorkspace(req, res) { res.json({ data: await service.getWorkspace(tenantId(req)) }); },
    async createRegistration(req, res) { res.status(201).json({ data: await service.createRegistration(tenantId(req), req.validated.body, actorContext(req)) }); },
    async updateRegistration(req, res) { res.json({ data: await service.updateRegistration(tenantId(req), req.validated.params.registrationId, req.validated.body, actorContext(req)) }); },
    async createCategory(req, res) { res.status(201).json({ data: await service.createCategory(tenantId(req), req.validated.body, actorContext(req)) }); },
    async updateCategory(req, res) { res.json({ data: await service.updateCategory(tenantId(req), req.validated.params.categoryId, req.validated.body, actorContext(req)) }); },
    async createRate(req, res) { res.status(201).json({ data: await service.createRate(tenantId(req), req.validated.params.categoryId, req.validated.body, actorContext(req)) }); },
    async updateRate(req, res) { res.json({ data: await service.updateRate(tenantId(req), req.validated.params.rateId, req.validated.body, actorContext(req)) }); },
    async createInvoiceSeries(req, res) { res.status(201).json({ data: await service.createInvoiceSeries(tenantId(req), req.validated.body, actorContext(req)) }); },
    async updateInvoiceSeries(req, res) { res.json({ data: await service.updateInvoiceSeries(tenantId(req), req.validated.params.seriesId, req.validated.body, actorContext(req)) }); },
    async issueTaxInvoice(req, res) { res.status(201).json({ data: await service.issueTaxInvoice(tenantId(req), req.validated.body, actorContext(req)) }); },
    async getTaxDocument(req, res) { res.json({ data: await service.getTaxDocument(tenantId(req), req.validated.params.documentId) }); },
    async getTaxDocumentPdf(req, res) {
      const result = await service.getTaxDocumentPdf(tenantId(req), req.validated.params.documentId);
      const disposition = req.query.disposition === "inline" ? "inline" : "attachment";
      res.set({ "Content-Type": "application/pdf", "Content-Length": String(result.buffer.length),
        "Content-Disposition": `${disposition}; filename="${result.filename}"`,
        "Cache-Control": "private, no-store" });
      res.status(200).send(result.buffer);
    }
  };
}
