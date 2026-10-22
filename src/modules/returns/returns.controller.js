import * as defaultService from "./returns.service.js";

function actorContext(req) {
  return { actorUserId: req.context.actor.userId, requestId: req.context.requestId,
    ipAddress: req.ip, userAgent: req.get("user-agent") || null };
}

export function createReturnsController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async options(req, res) { res.json({ data: await service.listReturnOptions(tenantId(req)) }); },
    async list(req, res) { res.json({ data: await service.listReturns(tenantId(req), req.validated.query) }); },
    async create(req, res) {
      res.status(201).json({ data: await service.createReturn(tenantId(req), req.validated.body, actorContext(req)) });
    },
    async get(req, res) { res.json({ data: await service.getReturn(tenantId(req), req.validated.params.returnId) }); },
    async approve(req, res) { res.json({ data: await service.approveReturn(tenantId(req), req.validated.params.returnId, req.validated.body, actorContext(req)) }); },
    async reject(req, res) { res.json({ data: await service.rejectReturn(tenantId(req), req.validated.params.returnId, req.validated.body, actorContext(req)) }); },
    async receive(req, res) { res.json({ data: await service.receiveReturn(tenantId(req), req.validated.params.returnId, req.validated.body, actorContext(req)) }); },
    async inspect(req, res) { res.json({ data: await service.inspectReturn(tenantId(req), req.validated.params.returnId, req.validated.body, actorContext(req)) }); },
    async complete(req, res) { res.json({ data: await service.completeReturn(tenantId(req), req.validated.params.returnId, req.validated.body, actorContext(req)) }); },
    async createExchange(req, res) { res.status(201).json({ data: await service.createExchange(tenantId(req), req.validated.params.returnId, req.validated.body, actorContext(req)) }); },
    async completeExchange(req, res) { res.json({ data: await service.completeExchange(tenantId(req), req.validated.params.exchangeId, req.validated.body, actorContext(req)) }); }
  };
}

