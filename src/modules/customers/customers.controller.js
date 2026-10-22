import * as defaultService from "./customers.service.js";

function actorContext(req) {
  return { actorUserId: req.context.actor.userId, requestId: req.context.requestId,
    ipAddress: req.ip, userAgent: req.get("user-agent") || null };
}

export function createCustomersController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async list(req, res) {
      res.json({ data: await service.listCustomers(tenantId(req), req.validated.query) });
    },
    async get(req, res) {
      res.json({ data: await service.getCustomer(tenantId(req), req.validated.params.customerId) });
    },
    async update(req, res) {
      res.json({ data: await service.updateCustomer(tenantId(req), req.validated.params.customerId,
        req.validated.body, actorContext(req)) });
    }
  };
}
