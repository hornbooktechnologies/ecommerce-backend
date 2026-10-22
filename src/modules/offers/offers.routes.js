import { Router } from "express";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { authenticate } from "../auth/auth.middleware.js";
import * as defaultService from "./offers.service.js";
import { createOffersController } from "./offers.controller.js";
import { createOfferSchema, listOffersSchema, offerOptionsSchema, offerParamsSchema, priceListParamsSchema,
  priceListSchema, updateOfferSchema, validateBody, validateParams, validateQuery } from "./offers.validators.js";

export function createOffersRouter({ offersService = defaultService,
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router(); const controller = createOffersController(offersService);
  router.use(authenticate, resolveTenant);
  router.get("/offers/options", authorize("catalog.offer.read"), validateQuery(offerOptionsSchema), controller.options);
  router.get("/offers", authorize("catalog.offer.read"), validateQuery(listOffersSchema), controller.list);
  router.post("/offers", authorize("catalog.offer.manage"), validateBody(createOfferSchema), controller.create);
  router.get("/offers/:offerId", authorize("catalog.offer.read"), validateParams(offerParamsSchema), controller.get);
  router.patch("/offers/:offerId", authorize("catalog.offer.manage"), validateParams(offerParamsSchema), validateBody(updateOfferSchema), controller.update);
  router.get("/price-lists", authorize("catalog.offer.read"), controller.listPriceLists);
  router.post("/price-lists", authorize("catalog.offer.manage"), validateBody(priceListSchema), controller.createPriceList);
  router.patch("/price-lists/:priceListId", authorize("catalog.offer.manage"), validateParams(priceListParamsSchema), validateBody(priceListSchema), controller.updatePriceList);
  return router;
}
