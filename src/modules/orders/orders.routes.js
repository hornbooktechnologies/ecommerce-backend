import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import * as defaultService from "./orders.service.js";
import { createOrdersController } from "./orders.controller.js";
import { allocateFulfillmentSchema, createOrderSchema, fulfillmentItemSchema,
  listOrdersSchema, orderItemSchema, transitionFulfillmentSchema, transitionOrderSchema,
  validateBody, validateParams, validateQuery } from "./orders.validators.js";

export function createOrdersRouter({
  ordersService = defaultService,
  resolveTenant = resolveTenantAccess,
  authorize = requirePermission
} = {}) {
  const router = Router();
  const controller = createOrdersController(ordersService);
  router.use(authenticate, resolveTenant);
  router.get("/orders/options", authorize("order.create"), controller.options);
  router.get("/orders", authorize("order.read"), validateQuery(listOrdersSchema), controller.list);
  router.post("/orders", authorize("order.create"), validateBody(createOrderSchema), controller.create);
  router.get("/orders/:orderId/fulfillment-options", authorize("order.manage"),
    validateParams(orderItemSchema), controller.fulfillmentOptions);
  router.post("/orders/:orderId/fulfillments", authorize("order.manage"),
    validateParams(orderItemSchema), validateBody(allocateFulfillmentSchema), controller.allocateFulfillment);
  router.patch("/orders/:orderId/fulfillments/:fulfillmentId/status", authorize("order.manage"),
    validateParams(fulfillmentItemSchema), validateBody(transitionFulfillmentSchema),
    controller.transitionFulfillment);
  router.get("/orders/:orderId", authorize("order.read"), validateParams(orderItemSchema), controller.get);
  router.patch("/orders/:orderId/status", authorize("order.manage"), validateParams(orderItemSchema),
    validateBody(transitionOrderSchema), controller.transition);
  return router;
}
