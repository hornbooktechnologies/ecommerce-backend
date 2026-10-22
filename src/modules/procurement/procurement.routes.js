import { Router } from "express";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { authenticate } from "../auth/auth.middleware.js";
import * as defaultService from "./procurement.service.js";
import { createProcurementController } from "./procurement.controller.js";
import { createPurchaseOrderSchema, listPurchaseOrdersSchema, listSuppliersSchema, orderParamsSchema,
  supplierParamsSchema, supplierSchema, validateBody, validateParams, validateQuery } from "./procurement.validators.js";

export function createProcurementRouter({ procurementService = defaultService,
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router(); const controller = createProcurementController(procurementService);
  router.use(authenticate, resolveTenant);
  router.get("/procurement/options", authorize("procurement.read"), controller.options);
  router.get("/suppliers", authorize("procurement.read"), validateQuery(listSuppliersSchema), controller.suppliers);
  router.post("/suppliers", authorize("procurement.manage"), validateBody(supplierSchema), controller.createSupplier);
  router.patch("/suppliers/:supplierId", authorize("procurement.manage"), validateParams(supplierParamsSchema), validateBody(supplierSchema), controller.updateSupplier);
  router.get("/purchase-orders", authorize("procurement.read"), validateQuery(listPurchaseOrdersSchema), controller.orders);
  router.post("/purchase-orders", authorize("procurement.manage"), validateBody(createPurchaseOrderSchema), controller.createOrder);
  router.get("/purchase-orders/:purchaseOrderId", authorize("procurement.read"), validateParams(orderParamsSchema), controller.order);
  router.post("/purchase-orders/:purchaseOrderId/approve", authorize("procurement.manage"), validateParams(orderParamsSchema), controller.approve);
  router.post("/purchase-orders/:purchaseOrderId/cancel", authorize("procurement.manage"), validateParams(orderParamsSchema), controller.cancel);
  return router;
}
