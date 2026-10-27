import { Router } from "express";
import Joi from "joi";
import { validate } from "../customer-accounts/customer-accounts.validators.js";
import { createStorefrontCartService } from "./storefront-cart.service.js";

const quantity = Joi.number().min(0).max(1000000).precision(6).strict().required();
const line = Joi.object({ offerId: Joi.string().guid().required(), quantity: quantity.greater(0) });
const cartKey = Joi.string().pattern(/^[a-f0-9]{64}$/).required();
const schemas = {
  sync: Joi.object({ legacyItems: Joi.array().items(line).max(50).unique("offerId").default([]) }),
  update: Joi.object({ offerId: Joi.string().guid().required(), quantity, cartKey, revision: Joi.number().integer().min(0).required() }),
  clear: Joi.object({ cartKey, revision: Joi.number().integer().min(0).required() })
};
export function createStorefrontCartRouter({ service = createStorefrontCartService() } = {}) {
  const router = Router();
  const base = "/:tenantCode/stores/:storeCode/cart";
  for (const [method, suffix, operation] of [["post", "/sync", "sync"], ["put", "", "update"], ["delete", "", "clear"]]) {
    router[method](`${base}${suffix}`, async (req, res) => {
      res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
      const params = validate(Joi.object({ tenantCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required(), storeCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required() }), req.params);
      const body = validate(schemas[operation], req.body);
      const store = await service.scope(params);
      await service.limit(store, req.ip);
      // A malformed Authorization header must never silently become a guest request.
      const sessionToken = req.headers.authorization ? req.headers.authorization.match(/^Bearer ([a-f0-9]{64})$/)?.[1] || "invalid" : "";
      const guestToken = req.headers["x-cart-token"] || "";
      res.json({ data: await service.operate(store, { sessionToken, guestToken }, operation, body) });
    });
  }
  return router;
}
