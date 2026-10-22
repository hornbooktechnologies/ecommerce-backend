import * as defaultService from "./vendor-portal.service.js";

function ids(req) { return { tenantId: req.context.vendor.tenantId, merchantId: req.context.vendor.merchantId }; }
function actor(req) { return { actorUserId: req.context.actor.userId, requestId: req.context.requestId,
  ipAddress: req.ip, userAgent: req.get("user-agent") || null }; }
export function createVendorPortalController(service = defaultService) {
  return {
    async workspace(req, res) { const value = ids(req); res.json({ data: await service.getWorkspace(value.tenantId, value.merchantId) }); },
    async updateProfile(req, res) { const value = ids(req); res.json({ data: await service.updateProfile(value.tenantId,
      value.merchantId, req.validated.body, actor(req)) }); },
    async updateOffer(req, res) { const value = ids(req); res.json({ data: await service.updateOffer(value.tenantId,
      value.merchantId, req.validated.params.offerId, req.validated.body, actor(req)) }); },
    async listOrders(req, res) { const value = ids(req); res.json({ data: await service.listOrders(value.tenantId,
      value.merchantId, req.validated.query) }); },
    async getOrder(req, res) { const value = ids(req); res.json({ data: await service.getOrder(value.tenantId,
      value.merchantId, req.validated.params.sellerOrderId) }); },
    async decideOrder(req, res) { const value = ids(req); res.json({ data: await service.decideOrder(value.tenantId,
      value.merchantId, req.validated.params.sellerOrderId, req.validated.body, actor(req)) }); },
    async fulfillmentOptions(req, res) { const value = ids(req); res.json({ data: await service.getFulfillmentOptions(
      value.tenantId, value.merchantId, req.validated.params.sellerOrderId) }); },
    async allocateFulfillment(req, res) { const value = ids(req); res.status(201).json({ data: await service.allocateFulfillment(
      value.tenantId, value.merchantId, req.validated.params.sellerOrderId, req.validated.body, actor(req)) }); },
    async transitionFulfillment(req, res) { const value = ids(req); res.json({ data: await service.transitionFulfillment(
      value.tenantId, value.merchantId, req.validated.params.sellerOrderId,
      req.validated.params.fulfillmentId, req.validated.body, actor(req)) }); }
  };
}
