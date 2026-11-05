import { Router } from "express";
import Joi from "joi";
import { authenticate } from "../auth/auth.middleware.js";
import {
  requirePermission,
  resolveTenantAccess,
} from "../access-control/access-control.middleware.js";
import { validate } from "../customer-accounts/customer-accounts.validators.js";
import { createCodCollectionsService } from "./cod-collections.service.js";
const uuid = Joi.string().guid().required();
export const codCollectionSchema = Joi.object({
  requestId: uuid,
  orderVersion: Joi.number().integer().min(0).required(),
  amount: Joi.string()
    .pattern(/^(?:0|[1-9][0-9]{0,14})\.[0-9]{2}$/)
    .required(),
  reference: Joi.string().trim().min(3).max(120).required(),
  collectedAt: Joi.string()
    .isoDate()
    .strict()
    .pattern(/(?:Z|[+-][0-9]{2}:[0-9]{2})$/)
    .required(),
  notes: Joi.string().trim().max(1000).allow("").default(""),
  confirmed: Joi.boolean().strict().valid(true).required(),
}).required();
export function createCodCollectionsRouter({
  service = createCodCollectionsService(),
  resolveTenant = resolveTenantAccess,
  authorize = requirePermission,
} = {}) {
  const router = Router();
  router.use('/orders/:orderId/cod-collection', authenticate, resolveTenant);
  const orderId = (req) => validate(uuid, req.params.orderId);
  router.get(
    "/orders/:orderId/cod-collection",
    authorize("order.read"),
    async (req, res) => {
      res
        .set("Cache-Control", "no-store")
        .json({
          data: await service.get(req.context.tenant.tenantId, orderId(req)),
        });
    },
  );
  router.post(
    "/orders/:orderId/cod-collection",
    authorize("order.read"),
    authorize("order.payment.collect"),
    async (req, res) => {
      const input = validate(codCollectionSchema, req.body);
      const data = await service.collect(
        req.context.tenant.tenantId,
        orderId(req),
        input,
        {
          actorUserId: req.context.actor.userId,
          requestId: req.context.requestId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      );
      res
        .set("Cache-Control", "no-store")
        .status(data.replayed ? 200 : 201)
        .json({ data });
    },
  );
  return router;
}
