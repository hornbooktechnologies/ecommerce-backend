import { Router } from "express";
import Joi from "joi";
import { validate } from "../customer-accounts/customer-accounts.validators.js";
import { createStorefrontWishlistService } from "./storefront-wishlist.service.js";

export const wishlistSchemas = {
  sync: Joi.object({ legacyProductIds: Joi.array().items(Joi.string().guid().lowercase()).unique().max(100).default([]) }),
  update: Joi.object({ productId: Joi.string().guid().lowercase().required(), saved: Joi.boolean().strict().required(),
    listKey: Joi.string().pattern(/^[a-f0-9]{64}$/).required(), revision: Joi.number().integer().min(0).required() })
};
export function createStorefrontWishlistRouter({ service = createStorefrontWishlistService() } = {}) {
  const router = Router();
  for (const [method, suffix, operation] of [["post", "/sync", "sync"], ["put", "", "update"]]) {
    router[method](`/:tenantCode/stores/:storeCode/wishlist${suffix}`, async (req, res) => {
      res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
      const params = validate(Joi.object({ tenantCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required(), storeCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required() }), req.params);
      const input = validate(wishlistSchemas[operation], req.body);
      const scope = await service.scope(params); await service.limit(scope, req.ip);
      const sessionToken = req.headers.authorization ? req.headers.authorization.match(/^Bearer ([a-f0-9]{64})$/)?.[1] || "invalid" : "";
      res.json({ data: await service.operate(scope, { sessionToken, guestToken: req.headers["x-wishlist-token"] || "" }, operation, input) });
    });
  }
  return router;
}
