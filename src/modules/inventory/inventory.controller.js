import * as defaultService from "./inventory.service.js";

function actorContext(req) {
  return {
    actorUserId: req.context.actor.userId,
    requestId: req.context.requestId,
    ipAddress: req.ip,
    userAgent: req.get("user-agent") || null
  };
}

export function createInventoryController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async options(req, res) {
      res.json({ data: await service.listOptions(tenantId(req)) });
    },
    async lots(req, res) {
      res.json({ data: await service.listTraceabilityLots(tenantId(req), req.validated.query) });
    },
    async serials(req, res) {
      res.json({ data: await service.listTraceabilitySerials(tenantId(req), req.validated.query) });
    },
    async createWarehouse(req, res) {
      const warehouse = await service.createWarehouse(tenantId(req), req.validated.body, actorContext(req));
      res.status(201).json({ data: { warehouse } });
    },
    async getBalance(req, res) {
      res.json({ data: await service.getBalance(tenantId(req), req.validated.params.balanceId) });
    },
    async receive(req, res) {
      const result = await service.receiveStock(tenantId(req), req.validated.body, actorContext(req));
      res.status(201).json({ data: result });
    },
    async adjust(req, res) {
      const result = await service.adjustStock(tenantId(req), req.validated.body, actorContext(req));
      res.status(201).json({ data: result });
    },
    async updatePolicy(req, res) {
      const result = await service.updateStockPolicy(tenantId(req), req.validated.params.balanceId,
        req.validated.body, actorContext(req));
      res.json({ data: result });
    },
    async transfer(req, res) {
      const result = await service.transferStock(tenantId(req), req.validated.body, actorContext(req));
      res.status(201).json({ data: result });
    },
    async reconcileSerial(req, res) {
      const result = await service.reconcileSerial(tenantId(req), req.validated.params.serialId,
        req.validated.body, actorContext(req));
      res.json({ data: result });
    }
  };
}
