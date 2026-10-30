import { Router } from "express";
import Joi from "joi";
import { authenticate } from "../auth/auth.middleware.js";
import { resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { validate } from "../customer-accounts/customer-accounts.validators.js";
import { createPaymentsService } from "./payments.service.js";
import { paymentError } from "./razorpay.js";

export const paymentSettingsSchema = Joi.object({ codEnabled: Joi.boolean().strict().required(), onlineEnabled: Joi.boolean().strict().required(),
  keyId: Joi.string().trim().pattern(/^rzp_test_[A-Za-z0-9]+$/).max(80).allow("").default(""),
  keySecret: Joi.string().trim().min(16).max(200).allow("").default(""),
  webhookSecret: Joi.string().trim().min(16).max(200).allow("").default("") });
export function requirePaymentOwner(req, _res, next) {
  if (!req.context.tenant.assignments.some((role) => role.scopeType === "TENANT" && role.roleKey === "tenant_owner")) {
    paymentError("FORBIDDEN", "Only the tenant owner can manage payment accounts.", 403);
  }
  next();
}
export function createPaymentsRouter({ service = createPaymentsService(), resolveTenant = resolveTenantAccess } = {}) {
  const router = Router();
  router.use("/stores/:storeId/payments", authenticate, resolveTenant, requirePaymentOwner);
  const scope = (req) => ({ tenantId: req.context.tenant.tenantId, actorUserId: req.context.actor.userId,
    storeId: validate(Joi.object({ storeId: Joi.string().guid().required() }), req.params).storeId });
  router.get("/stores/:storeId/payments", async (req, res) => {
    res.set("Cache-Control", "no-store").json({ data: await service.getSettings(scope(req)) });
  });
  router.put("/stores/:storeId/payments", async (req, res) => {
    res.set("Cache-Control", "no-store").json({ data: await service.saveSettings(scope(req), validate(paymentSettingsSchema, req.body)) });
  });
  return router;
}
