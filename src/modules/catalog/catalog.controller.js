import * as defaultService from "./catalog.service.js";

function actorContext(req) {
  return { actorUserId: req.context.actor.userId, requestId: req.context.requestId,
    ipAddress: req.ip, userAgent: req.get("user-agent") || null };
}

export function createCatalogController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async lookups(req, res) {
      res.json({ data: await service.ensureDefaults(tenantId(req)) });
    },
    async listProducts(req, res) {
      res.json({ data: await service.listProducts(tenantId(req), req.validated.query) });
    },
    async createProduct(req, res) {
      const product = await service.createProduct(tenantId(req), req.validated.body, actorContext(req));
      res.status(201).json({ data: { product } });
    },
    async getProductVariants(req, res) {
      res.json({ data: await service.getProductVariants(
        tenantId(req), req.validated.params.productId
      ) });
    },
    async listProductMedia(req, res) {
      res.json({ data: await service.listProductMedia(tenantId(req), req.validated.params.productId) });
    },
    async addProductMedia(req, res) {
      res.status(201).json({ data: await service.addProductMedia(tenantId(req), req.validated.params.productId,
        req.validated.body, actorContext(req)) });
    },
    async uploadProductMedia(req, res) {
      res.status(201).json({ data: await service.uploadProductMedia(tenantId(req),
        req.validated.params.productId, req.validated.query, {
          buffer: req.body, mimeType: req.get("content-type"), originalName: req.validated.query.fileName
        }, actorContext(req)) });
    },
    async updateProductMedia(req, res) {
      res.json({ data: await service.updateProductMedia(tenantId(req), req.validated.params.productId,
        req.validated.params.mediaId, req.validated.body, actorContext(req)) });
    },
    async replaceProductMediaFile(req, res) {
      res.json({ data: await service.replaceProductMediaFile(tenantId(req),
        req.validated.params.productId, req.validated.params.mediaId, req.validated.query, {
          buffer: req.body, mimeType: req.get("content-type"), originalName: req.validated.query.fileName
        }, actorContext(req)) });
    },
    async primaryProductMedia(req, res) {
      res.json({ data: await service.primaryProductMedia(tenantId(req), req.validated.params.productId,
        req.validated.params.mediaId, actorContext(req)) });
    },
    async reorderProductMedia(req, res) {
      res.json({ data: await service.reorderProductMedia(tenantId(req), req.validated.params.productId,
        req.validated.params.mediaId, req.validated.body, actorContext(req)) });
    },
    async removeProductMedia(req, res) {
      res.json({ data: await service.removeProductMedia(tenantId(req), req.validated.params.productId,
        req.validated.params.mediaId, actorContext(req)) });
    },
    async updateProduct(req, res) {
      res.json({ data: await service.updateProduct(
        tenantId(req), req.validated.params.productId, req.validated.body, actorContext(req)
      ) });
    },
    async updateProductPrices(req, res) {
      res.json({ data: await service.updateProductPrices(
        tenantId(req), req.validated.params.productId, req.validated.body, actorContext(req)
      ) });
    },
    async submitProduct(req, res) {
      res.json({ data: await service.transitionProduct(
        tenantId(req), req.validated.params.productId, "submit", actorContext(req)
      ) });
    },
    async approveProduct(req, res) {
      res.json({ data: await service.transitionProduct(
        tenantId(req), req.validated.params.productId, "approve", actorContext(req), req.validated.body
      ) });
    },
    async rejectProduct(req, res) {
      res.json({ data: await service.transitionProduct(
        tenantId(req), req.validated.params.productId, "reject", actorContext(req), req.validated.body
      ) });
    },
    async publishProduct(req, res) {
      res.json({ data: await service.transitionProduct(
        tenantId(req), req.validated.params.productId, "publish", actorContext(req)
      ) });
    },
    async archiveProduct(req, res) {
      res.json({ data: await service.transitionProduct(
        tenantId(req), req.validated.params.productId, "archive", actorContext(req)
      ) });
    },
    async restoreProduct(req, res) {
      res.json({ data: await service.transitionProduct(
        tenantId(req), req.validated.params.productId, "restore", actorContext(req)
      ) });
    },
    async deleteProduct(req, res) {
      await service.deleteProduct(tenantId(req), req.validated.params.productId, actorContext(req));
      res.status(204).send();
    },
    async listMasters(req, res) {
      res.json({ data: { items: await service.listMasters(
        tenantId(req), req.validated.params.masterType, req.validated.query
      ) } });
    },
    async createMaster(req, res) {
      const item = await service.createMaster(
        tenantId(req), req.validated.params.masterType, req.validated.body, actorContext(req)
      );
      res.status(201).json({ data: { item } });
    },
    async updateMaster(req, res) {
      const item = await service.updateMaster(
        tenantId(req), req.validated.params.masterType, req.validated.params.itemId,
        req.validated.body, actorContext(req)
      );
      res.json({ data: { item } });
    },
    async listInventory(req, res) {
      res.json({ data: await service.listInventory(tenantId(req), req.validated.query) });
    }
  };
}
