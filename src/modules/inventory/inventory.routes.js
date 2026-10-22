import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import * as defaultService from "./inventory.service.js";
import { createInventoryController } from "./inventory.controller.js";
import { adjustStockSchema, balanceSchema, createWarehouseSchema, listTraceabilityLotsSchema,
  listTraceabilitySerialsSchema, receiveStockSchema, reconcileSerialSchema, serialSchema,
  transferStockSchema, updateStockPolicySchema,
  validateBody, validateParams, validateQuery } from "./inventory.validators.js";

export function createInventoryRouter({
  inventoryService = defaultService,
  resolveTenant = resolveTenantAccess,
  authorize = requirePermission
} = {}) {
  const router = Router();
  const controller = createInventoryController(inventoryService);
  router.use(authenticate, resolveTenant);
  router.get("/inventory/options", authorize("inventory.stock.read"), controller.options);
  router.get("/inventory/traceability/lots", authorize("inventory.stock.read"),
    validateQuery(listTraceabilityLotsSchema), controller.lots);
  router.get("/inventory/traceability/serials", authorize("inventory.stock.read"),
    validateQuery(listTraceabilitySerialsSchema), controller.serials);
  router.patch("/inventory/traceability/serials/:serialId", authorize("inventory.stock.manage"),
    validateParams(serialSchema), validateBody(reconcileSerialSchema), controller.reconcileSerial);
  router.post("/inventory/warehouses", authorize("inventory.stock.manage"),
    validateBody(createWarehouseSchema), controller.createWarehouse);
  router.get("/inventory/:balanceId", authorize("inventory.stock.read"),
    validateParams(balanceSchema), controller.getBalance);
  router.patch("/inventory/:balanceId/policy", authorize("inventory.stock.manage"),
    validateParams(balanceSchema), validateBody(updateStockPolicySchema), controller.updatePolicy);
  router.post("/inventory/receipts", authorize("inventory.stock.manage"),
    validateBody(receiveStockSchema), controller.receive);
  router.post("/inventory/adjustments", authorize("inventory.stock.manage"),
    validateBody(adjustStockSchema), controller.adjust);
  router.post("/inventory/transfers", authorize("inventory.stock.manage"),
    validateBody(transferStockSchema), controller.transfer);
  return router;
}
