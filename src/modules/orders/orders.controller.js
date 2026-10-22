import * as defaultService from "./orders.service.js";

function actorContext(req) {
  return { actorUserId: req.context.actor.userId, requestId: req.context.requestId,
    ipAddress: req.ip, userAgent: req.get("user-agent") || null };
}

export function createOrdersController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async options(req, res) {
      res.json({ data: await service.listCreationOptions(tenantId(req)) });
    },
    async list(req, res) {
      res.json({ data: await service.listOrders(tenantId(req), req.validated.query) });
    },
    async create(req, res) {
      const order = await service.createOrder(tenantId(req), req.validated.body, actorContext(req));
      res.status(201).json({ data: order });
    },
    async get(req, res) {
      res.json({ data: await service.getOrder(tenantId(req), req.validated.params.orderId) });
    },
    async fulfillmentOptions(req, res) {
      res.json({ data: await service.getFulfillmentOptions(tenantId(req), req.validated.params.orderId) });
    },
    async allocateFulfillment(req, res) {
      const result = await service.allocateFulfillment(tenantId(req), req.validated.params.orderId,
        req.validated.body, actorContext(req));
      res.status(201).json({ data: result });
    },
    async transitionFulfillment(req, res) {
      res.json({ data: await service.transitionFulfillment(tenantId(req),
        req.validated.params.orderId, req.validated.params.fulfillmentId,
        req.validated.body, actorContext(req)) });
    },
    async transition(req, res) {
      res.json({ data: await service.transitionOrder(tenantId(req), req.validated.params.orderId,
        req.validated.body, actorContext(req)) });
    }
  };
}
