import { Router } from "express";
import Joi from "joi";
import { authenticate } from "../auth/auth.middleware.js";
import { resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { resolveVendorAccess } from "../vendor-portal/vendor-portal.middleware.js";
import { validate } from "../customer-accounts/customer-accounts.validators.js";
import { createInboxService } from "./inbox.service.js";

export const inboxSchemas = {
  list: Joi.object({
    category: Joi.string().uppercase().valid("ALL", "ORDERS", "RETURNS", "PAYMENTS", "INVENTORY", "WARRANTIES", "IMPORTS", "APPROVALS", "TENANTS").default("ALL"),
    search: Joi.string().trim().max(100).allow("").default(""),
    filter: Joi.string().uppercase().valid("ALL", "UNREAD").default("ALL"),
    page: Joi.number().integer().min(1).max(10000).default(1), pageSize: Joi.number().integer().valid(10, 20, 50).default(10) }),
  item: Joi.string().guid().required(),
  mark: Joi.object({ read: Joi.boolean().strict().required() }),
  all: Joi.object({ throughId: Joi.string().guid().required() }),
  store: Joi.object({ tenantCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required(),
    storeCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required() })
};
export function createInboxRouter({ audience, service = createInboxService(),
  resolveTenant = resolveTenantAccess, resolveVendor = resolveVendorAccess } = {}) {
  if (!["ADMIN", "VENDOR", "CUSTOMER", "PLATFORM"].includes(audience)) throw new Error("Invalid inbox audience");
  const router = Router({ mergeParams: true });
  router.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }); next(); });
  if (audience !== "CUSTOMER") router.use(authenticate);
  if (audience === "ADMIN") router.use(resolveTenant);
  if (audience === "VENDOR") router.use(resolveVendor);
  router.use(async (req, _res, next) => {
    req.inboxScope = audience === "CUSTOMER"
      ? await service.customerScope(validate(inboxSchemas.store, req.params), req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] || "")
      : await service.userScope(req.context, audience);
    next();
  });
  router.get("/", async (req, res) => res.json({ data: await service.list(req.inboxScope, validate(inboxSchemas.list, req.query)) }));
  router.get("/unread-count", async (req, res) => res.json({ data: await service.unread(req.inboxScope) }));
  router.post("/read-all", async (req, res) => res.json({ data: await service.markAll(req.inboxScope, validate(inboxSchemas.all, req.body).throughId) }));
  router.patch("/:notificationId", async (req, res) => res.json({ data: await service.mark(req.inboxScope,
    validate(inboxSchemas.item, req.params.notificationId), validate(inboxSchemas.mark, req.body).read) }));
  return router;
}
