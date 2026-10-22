import { raw, Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import * as defaultService from "./catalog.service.js";
import { createCatalogController } from "./catalog.controller.js";
import { createMasterSchema, createProductMediaSchema, createProductSchema, listInventorySchema, listMastersSchema,
  listProductsSchema, masterItemSchema, masterTypeSchema, productItemSchema,
  productApprovalSchema, productMediaItemSchema, productRejectionSchema, reorderProductMediaSchema, updateMasterSchema,
  updateProductMediaSchema, updateProductPricesSchema, updateProductSchema,
  uploadProductMediaSchema, validateBody, validateParams, validateQuery } from "./catalog.validators.js";

export function createCatalogRouter({
  catalogService = defaultService,
  resolveTenant = resolveTenantAccess,
  authorize = requirePermission
} = {}) {
  const router = Router();
  const controller = createCatalogController(catalogService);
  router.use(authenticate, resolveTenant);
  router.get("/catalog/lookups", authorize("catalog.product.read"), controller.lookups);
  router.get("/catalog/masters/:masterType", authorize("catalog.product.read"),
    validateParams(masterTypeSchema), validateQuery(listMastersSchema), controller.listMasters);
  router.post("/catalog/masters/:masterType", authorize("catalog.product.create"),
    validateParams(masterTypeSchema), validateBody(createMasterSchema), controller.createMaster);
  router.patch("/catalog/masters/:masterType/:itemId", authorize("catalog.product.update"),
    validateParams(masterItemSchema), validateBody(updateMasterSchema), controller.updateMaster);
  router.get("/catalog/products", authorize("catalog.product.read"), validateQuery(listProductsSchema), controller.listProducts);
  router.post("/catalog/products", authorize("catalog.product.create"), validateBody(createProductSchema), controller.createProduct);
  router.get("/catalog/products/:productId/variants", authorize("catalog.product.read"),
    validateParams(productItemSchema), controller.getProductVariants);
  router.get("/catalog/products/:productId/media", authorize("catalog.product.read"),
    validateParams(productItemSchema), controller.listProductMedia);
  router.post("/catalog/products/:productId/media", authorize("catalog.product.update"),
    validateParams(productItemSchema), validateBody(createProductMediaSchema), controller.addProductMedia);
  router.post("/catalog/products/:productId/media/upload", authorize("catalog.product.update"),
    validateParams(productItemSchema), validateQuery(uploadProductMediaSchema),
    raw({ type: () => true, limit: "8mb" }), controller.uploadProductMedia);
  router.patch("/catalog/products/:productId/media/:mediaId", authorize("catalog.product.update"),
    validateParams(productMediaItemSchema), validateBody(updateProductMediaSchema), controller.updateProductMedia);
  router.put("/catalog/products/:productId/media/:mediaId/upload", authorize("catalog.product.update"),
    validateParams(productMediaItemSchema), validateQuery(uploadProductMediaSchema),
    raw({ type: () => true, limit: "8mb" }), controller.replaceProductMediaFile);
  router.post("/catalog/products/:productId/media/:mediaId/primary", authorize("catalog.product.update"),
    validateParams(productMediaItemSchema), controller.primaryProductMedia);
  router.put("/catalog/products/:productId/media/:mediaId/order", authorize("catalog.product.update"),
    validateParams(productMediaItemSchema), validateBody(reorderProductMediaSchema), controller.reorderProductMedia);
  router.delete("/catalog/products/:productId/media/:mediaId", authorize("catalog.product.update"),
    validateParams(productMediaItemSchema), controller.removeProductMedia);
  router.patch("/catalog/products/:productId", authorize("catalog.product.update"),
    validateParams(productItemSchema), validateBody(updateProductSchema), controller.updateProduct);
  router.put("/catalog/products/:productId/prices", authorize("catalog.product.update"),
    validateParams(productItemSchema), validateBody(updateProductPricesSchema), controller.updateProductPrices);
  router.post("/catalog/products/:productId/submit", authorize("catalog.product.update"),
    validateParams(productItemSchema), controller.submitProduct);
  router.post("/catalog/products/:productId/approve", authorize("catalog.product.approve"),
    validateParams(productItemSchema), validateBody(productApprovalSchema), controller.approveProduct);
  router.post("/catalog/products/:productId/reject", authorize("catalog.product.approve"),
    validateParams(productItemSchema), validateBody(productRejectionSchema), controller.rejectProduct);
  router.post("/catalog/products/:productId/publish", authorize("catalog.product.approve"),
    validateParams(productItemSchema), controller.publishProduct);
  router.post("/catalog/products/:productId/archive", authorize("catalog.product.update"),
    validateParams(productItemSchema), controller.archiveProduct);
  router.post("/catalog/products/:productId/restore", authorize("catalog.product.update"),
    validateParams(productItemSchema), controller.restoreProduct);
  router.delete("/catalog/products/:productId", authorize("catalog.product.update"),
    validateParams(productItemSchema), controller.deleteProduct);
  router.get("/inventory", authorize("inventory.stock.read"), validateQuery(listInventorySchema), controller.listInventory);
  return router;
}
