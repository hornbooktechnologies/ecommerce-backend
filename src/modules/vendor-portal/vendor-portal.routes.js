import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { createVendorPortalController } from "./vendor-portal.controller.js";
import { requireVendorPermission, resolveVendorAccess } from "./vendor-portal.middleware.js";
import * as defaultService from "./vendor-portal.service.js";
import { allocateSellerOrderFulfillmentSchema, listSellerOrdersSchema, offerIdSchema,
  sellerOrderDecisionSchema, sellerOrderFulfillmentIdSchema, sellerOrderIdSchema,
  transitionSellerOrderFulfillmentSchema, updateOfferSchema, updateProfileSchema, validateBody, validateParams,
  validateQuery } from "./vendor-portal.validators.js";

export function createVendorPortalRouter({ vendorPortalService = defaultService,
  resolveVendor = resolveVendorAccess, authorize = requireVendorPermission } = {}) {
  const router = Router(); const controller = createVendorPortalController(vendorPortalService);
  router.use(authenticate, resolveVendor);
  router.get("/workspace", authorize("vendor.dashboard.read"), controller.workspace);
  router.patch("/profile", authorize("vendor.profile.update"), validateBody(updateProfileSchema), controller.updateProfile);
  router.patch("/offers/:offerId", authorize("vendor.offer.update"), validateParams(offerIdSchema),
    validateBody(updateOfferSchema), controller.updateOffer);
  router.get("/orders", authorize("vendor.order.read"), validateQuery(listSellerOrdersSchema), controller.listOrders);
  router.get("/orders/:sellerOrderId", authorize("vendor.order.read"),
    validateParams(sellerOrderIdSchema), controller.getOrder);
  router.post("/orders/:sellerOrderId/decision", authorize("vendor.order.manage"),
    validateParams(sellerOrderIdSchema), validateBody(sellerOrderDecisionSchema), controller.decideOrder);
  router.get("/orders/:sellerOrderId/fulfillment-options", authorize("vendor.fulfillment.read"),
    validateParams(sellerOrderIdSchema), controller.fulfillmentOptions);
  router.post("/orders/:sellerOrderId/fulfillments", authorize("vendor.fulfillment.manage"),
    validateParams(sellerOrderIdSchema), validateBody(allocateSellerOrderFulfillmentSchema),
    controller.allocateFulfillment);
  router.patch("/orders/:sellerOrderId/fulfillments/:fulfillmentId/status",
    authorize("vendor.fulfillment.manage"), validateParams(sellerOrderFulfillmentIdSchema),
    validateBody(transitionSellerOrderFulfillmentSchema), controller.transitionFulfillment);
  return router;
}
