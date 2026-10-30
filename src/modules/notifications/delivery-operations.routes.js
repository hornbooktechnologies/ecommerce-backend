import { Router } from "express";
import Joi from "joi";
import { authenticate } from "../auth/auth.middleware.js";
import { validate } from "../customer-accounts/customer-accounts.validators.js";
import { createDeliveryOperationsService } from "./delivery-operations.service.js";

export const deliveryOperationsSchemas = {
  list: Joi.object({
    status: Joi.string().valid("ALL", "FAILED", "QUEUED", "PROCESSED").default("FAILED"),
    audience: Joi.string().valid("ALL", "ADMIN", "VENDOR", "CUSTOMER", "PLATFORM").default("ALL"),
    search: Joi.string().trim().max(80).allow("").default(""),
    page: Joi.number().integer().min(1).max(10000).default(1),
    pageSize: Joi.number().integer().valid(10, 20, 50).default(10)
  }),
  history: Joi.object({
    page: Joi.number().integer().min(1).max(10000).default(1),
    pageSize: Joi.number().integer().valid(10, 20, 50).default(10)
  }),
  id: Joi.string().guid().required(),
  retry: Joi.object({ reason: Joi.string().trim().min(10).max(500).required(),
    expectedManualRetries: Joi.number().integer().min(0).max(3).required(),
    confirmed: Joi.boolean().strict().valid(true).required() })
};

export function createDeliveryOperationsRouter({ service = createDeliveryOperationsService() } = {}) {
  const router = Router();
  router.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }); next(); });
  router.use(authenticate);
  router.get("/health", async (req, res) => res.json({ data: await service.health(req.context) }));
  router.get("/", async (req, res) => res.json({ data: await service.list(req.context,
    validate(deliveryOperationsSchemas.list, req.query)) }));
  router.get("/:eventId/history", async (req, res) => res.json({ data: await service.history(req.context,
    validate(deliveryOperationsSchemas.id, req.params.eventId), validate(deliveryOperationsSchemas.history, req.query)) }));
  router.post("/:eventId/retry", async (req, res) => {
    const result = await service.retry({ ...req.context, ipAddress: req.ip, userAgent: req.get("user-agent") || null },
      validate(deliveryOperationsSchemas.id, req.params.eventId), validate(deliveryOperationsSchemas.retry, req.body));
    res.status(202).json({ data: result });
  });
  return router;
}
