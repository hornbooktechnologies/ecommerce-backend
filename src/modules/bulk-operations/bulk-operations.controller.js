import * as defaultService from "./bulk-operations.service.js";

const actor = (req) => ({ actorUserId: req.context.actor.userId, requestId: req.context.requestId,
  ipAddress: req.ip, userAgent: req.get("user-agent") || null });
function sendCsv(res, file) {
  res.set("content-type", "text/csv; charset=utf-8");
  res.set("content-disposition", `attachment; filename="${file.filename}"`);
  res.send(`\uFEFF${file.csv}`);
}

export function createBulkOperationsController(service = defaultService) {
  const tenant = (req) => req.context.tenant.tenantId;
  return {
    async jobs(req, res) { res.json({ data: await service.listJobs(tenant(req), req.validated.query) }); },
    async job(req, res) { res.json({ data: await service.getJob(tenant(req), req.validated.params.jobId) }); },
    validate(type) { return async (req, res) => res.status(201).json({ data: await service.validateImport(tenant(req), type, req.validated.body, actor(req)) }); },
    commit(type) { return async (req, res) => res.json({ data: await service.commitImport(tenant(req), type, req.validated.params.jobId, actor(req)) }); },
    template(type) { return async (_req, res) => sendCsv(res, service.template(type)); },
    export(type) { return async (req, res) => sendCsv(res, await service.exportFile(tenant(req), type)); },
    async errors(req, res) { sendCsv(res, await service.errorReport(tenant(req), req.validated.params.jobId)); },
    async status(req, res) { res.json({ data: await service.bulkTransition(tenant(req), req.validated.body.productIds,
      req.validated.body.action, actor(req)) }); },
    async publish(req, res) { res.json({ data: await service.bulkTransition(tenant(req), req.validated.body.productIds,
      "publish", actor(req)) }); }
  };
}
