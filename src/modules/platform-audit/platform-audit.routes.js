import { Router } from "express";
import Joi from "joi";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePlatformPermission } from "../platform-tenants/platform-authorization.middleware.js";
import { validateQuery } from "../platform-tenants/platform-tenants.validators.js";
import { activeSession } from "../platform-dashboard/platform-dashboard.dao.js";
import { AppError } from "../../core/errors/app-error.js";
import { listAuditEvents } from "./platform-audit.dao.js";

export const filtersSchema = Joi.object({
  search: Joi.string().trim().allow("").max(100).default(""),
  area: Joi.string().valid("ALL", "TENANT", "PLATFORM_USER", "PLATFORM_ROLE").default("ALL"),
  page: Joi.number().integer().min(1).max(1000000).default(1),
  pageSize: Joi.number().integer().valid(10, 20, 50).default(10)
});

export function createPlatformAuditRouter({ authorize = requirePlatformPermission, session = activeSession, list = listAuditEvents } = {}) {
  const router = Router();
  router.get("/", authenticate, authorize("platform.audit.read"), validateQuery(filtersSchema), async (req, res) => {
    if (!await session(req.context.actor)) throw new AppError({ code: "AUTHENTICATION_REQUIRED", message: "Your session is invalid or has expired.", status: 401 });
    res.set("Cache-Control", "private, no-store").json({ data: await list(req.validated.query) });
  });
  return router;
}
