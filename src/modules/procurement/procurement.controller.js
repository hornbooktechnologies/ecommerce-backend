import * as defaultService from "./procurement.service.js";

const actor = (req) => ({ actorUserId: req.context.actor.userId, requestId: req.context.requestId,
  ipAddress: req.ip, userAgent: req.get("user-agent") || null });
export function createProcurementController(service = defaultService) {
  const tenant = (req) => req.context.tenant.tenantId;
  return {
    async options(req, res) { res.json({ data: await service.listOptions(tenant(req)) }); },
    async suppliers(req, res) { res.json({ data: await service.listSuppliers(tenant(req), req.validated.query) }); },
    async createSupplier(req, res) { res.status(201).json({ data: await service.createSupplier(tenant(req), req.validated.body, actor(req)) }); },
    async updateSupplier(req, res) { res.json({ data: await service.updateSupplier(tenant(req), req.validated.params.supplierId, req.validated.body, actor(req)) }); },
    async orders(req, res) { res.json({ data: await service.listPurchaseOrders(tenant(req), req.validated.query) }); },
    async order(req, res) { res.json({ data: await service.getPurchaseOrder(tenant(req), req.validated.params.purchaseOrderId) }); },
    async createOrder(req, res) { res.status(201).json({ data: await service.createPurchaseOrder(tenant(req), req.validated.body, actor(req)) }); },
    async approve(req, res) { res.json({ data: await service.approvePurchaseOrder(tenant(req), req.validated.params.purchaseOrderId, actor(req)) }); },
    async cancel(req, res) { res.json({ data: await service.cancelPurchaseOrder(tenant(req), req.validated.params.purchaseOrderId, actor(req)) }); }
  };
}
