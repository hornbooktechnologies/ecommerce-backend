import { Router } from "express";
import Joi from "joi";
import { validate } from "../customer-accounts/customer-accounts.validators.js";
import { createStorefrontCheckoutService } from "./storefront-checkout.service.js";
const uuid = Joi.string().guid();
export const checkoutSchemas = {
  options: Joi.object({ addressId: uuid.allow(null).default(null) }),
  quote: Joi.object({ addressId: uuid.required(), deliverySlotId: uuid.required(),
    paymentMethod: Joi.string().valid("COD", "ONLINE_TEST").default("COD"),
    cartKey: Joi.string().pattern(/^[a-f0-9]{64}$/).required(), revision: Joi.number().integer().min(0).required(),
    couponCode: Joi.string().trim().uppercase().max(80).allow("").default(""),
    notes: Joi.string().trim().max(1000).allow("").default(""),
    substitutionPreference: Joi.string().valid("CONTACT_ME", "NO_SUBSTITUTION", "ALLOW_SIMILAR").default("CONTACT_ME") }),
  place: Joi.object({ quoteId: uuid.required() }),
  read: Joi.object({ quoteId: uuid.required() })
  ,pay: Joi.object({ quoteId: uuid.required() }),
  verify: Joi.object({ quoteId: uuid.required(), razorpay_order_id: Joi.string().pattern(/^order_[A-Za-z0-9]+$/).max(80).required(),
    razorpay_payment_id: Joi.string().pattern(/^pay_[A-Za-z0-9]+$/).max(80).required(), razorpay_signature: Joi.string().pattern(/^[a-f0-9]{64}$/i).required() })
};
export function createStorefrontCheckoutRouter({ service = createStorefrontCheckoutService() } = {}) {
  const router = Router();
  for (const operation of ["options", "quote", "place", "read", "pay", "verify"]) {
    router.post(`/:tenantCode/stores/:storeCode/checkout/${operation}`, async (req, res) => {
      res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
      const params = validate(Joi.object({ tenantCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required(), storeCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required() }), req.params);
      const input = validate(checkoutSchemas[operation], req.body);
      const store = await service.scope(params);
      await service.limit(store, req.ip);
      const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] || "";
      const data = await service[operation](store, token, input, { requestId: req.context?.requestId,
        ipAddress: req.ip, userAgent: req.get("user-agent") || "Storefront" });
      res.json({ data });
    });
  }
  return router;
}
