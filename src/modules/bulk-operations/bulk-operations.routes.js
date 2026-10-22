import { Router } from "express";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { authenticate } from "../auth/auth.middleware.js";
import * as defaultService from "./bulk-operations.service.js";
import { createBulkOperationsController } from "./bulk-operations.controller.js";
import { bulkPublishSchema, bulkStatusSchema, jobSchema, listJobsSchema, validateBody, validateImportSchema,
  validateParams, validateQuery } from "./bulk-operations.validators.js";

export function createBulkOperationsRouter({ bulkOperationsService = defaultService,
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router(); const controller = createBulkOperationsController(bulkOperationsService);
  router.use(authenticate, resolveTenant);
  router.get("/bulk/imports", authorize("bulk.read"), validateQuery(listJobsSchema), controller.jobs);
  router.get("/bulk/imports/:jobId", authorize("bulk.read"), validateParams(jobSchema), controller.job);
  router.get("/bulk/imports/:jobId/errors", authorize("bulk.read"), validateParams(jobSchema), controller.errors);

  const types = [
    { path: "products", type: "PRODUCT", read: "catalog.product.read", manage: "catalog.product.create" },
    { path: "pricing", type: "PRICING", read: "catalog.offer.read", manage: "catalog.offer.manage" },
    { path: "inventory", type: "INVENTORY", read: "inventory.stock.read", manage: "inventory.stock.receive" }
  ];
  for (const item of types) {
    router.get(`/bulk/${item.path}/template`, authorize(item.read), controller.template(item.type));
    router.get(`/bulk/${item.path}/export`, authorize(item.read), controller.export(item.type));
    router.post(`/bulk/${item.path}/validate`, authorize(item.manage), validateBody(validateImportSchema), controller.validate(item.type));
    router.post(`/bulk/${item.path}/imports/:jobId/commit`, authorize(item.manage), validateParams(jobSchema), controller.commit(item.type));
  }
  router.post("/bulk/products/status", authorize("catalog.product.update"), validateBody(bulkStatusSchema), controller.status);
  router.post("/bulk/products/publish", authorize("catalog.product.approve"), validateBody(bulkPublishSchema), controller.publish);
  return router;
}
