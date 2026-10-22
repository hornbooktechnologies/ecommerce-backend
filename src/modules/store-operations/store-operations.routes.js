import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import * as defaultService from "./store-operations.service.js";
import { createStoreOperationsController } from "./store-operations.controller.js";
import { assignWarehousesSchema, createStoreSchema, generateSlotsSchema, listStoresSchema,
  storeParamsSchema, templateParamsSchema, templateSchema, updateStoreSchema, validateBody,
  validateParams, validateQuery, zoneParamsSchema, zoneSchema } from "./store-operations.validators.js";

export function createStoreOperationsRouter({ storeOperationsService = defaultService,
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router();
  const controller = createStoreOperationsController(storeOperationsService);
  router.use(authenticate, resolveTenant);
  router.get("/stores", authorize("settings.store.read"), validateQuery(listStoresSchema), controller.list);
  router.post("/stores", authorize("settings.store.manage"), validateBody(createStoreSchema), controller.create);
  router.get("/stores/:storeId", authorize("settings.store.read"), validateParams(storeParamsSchema), controller.get);
  router.patch("/stores/:storeId", authorize("settings.store.manage"), validateParams(storeParamsSchema), validateBody(updateStoreSchema), controller.update);
  router.post("/stores/:storeId/zones", authorize("settings.store.manage"), validateParams(storeParamsSchema), validateBody(zoneSchema), controller.createZone);
  router.patch("/stores/:storeId/zones/:zoneId", authorize("settings.store.manage"), validateParams(zoneParamsSchema), validateBody(zoneSchema), controller.updateZone);
  router.post("/stores/:storeId/slots/generate", authorize("settings.store.manage"), validateParams(storeParamsSchema), validateBody(generateSlotsSchema), controller.generate);
  router.post("/stores/:storeId/slots", authorize("settings.store.manage"), validateParams(storeParamsSchema), validateBody(templateSchema), controller.createTemplate);
  router.patch("/stores/:storeId/slots/:templateId", authorize("settings.store.manage"), validateParams(templateParamsSchema), validateBody(templateSchema), controller.updateTemplate);
  router.put("/stores/:storeId/warehouses", authorize("settings.store.manage"), validateParams(storeParamsSchema), validateBody(assignWarehousesSchema), controller.assignWarehouses);
  return router;
}
