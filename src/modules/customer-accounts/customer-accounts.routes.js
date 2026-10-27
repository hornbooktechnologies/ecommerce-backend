import { Router } from "express";
import Joi from "joi";
import { createCustomerAccountsService } from "./customer-accounts.service.js";
import { schemas, validate } from "./customer-accounts.validators.js";

export const orderSchemas = {
  cancel: Joi.object({ orderId: Joi.string().guid().required(), reason: Joi.string().trim().min(3).max(1000).required() }),
  return: Joi.object({ orderId: Joi.string().guid().required(), orderItemId: Joi.string().guid().required(), requestId: Joi.string().guid().required(),
    returnType: Joi.string().valid("RETURN", "EXCHANGE").required(), quantity: Joi.number().precision(6).greater(0).max(1000000).required(),
    serialIds: Joi.array().items(Joi.string().guid()).unique().max(100).default([]),
    reasonCode: Joi.string().valid("DAMAGED", "DEFECTIVE", "WRONG_ITEM", "SIZE_FIT", "CHANGED_MIND", "QUALITY", "OTHER").required(),
    customerComments: Joi.string().trim().max(1000).allow("").default("") }),
  review: Joi.object({ orderId: Joi.string().guid().required(), orderItemId: Joi.string().guid().required(),
    rating: Joi.number().integer().min(1).max(5).required(), title: Joi.string().trim().max(190).allow("").default(""),
    review: Joi.string().trim().min(10).max(3000).required() }),
  list: Joi.object({ page: Joi.number().integer().min(1).max(100000).default(1), pageSize: Joi.number().valid(10, 20, 50).default(10) }),
  read: Joi.object({ orderId: Joi.string().guid().required() }),
  invoice: Joi.object({ orderId: Joi.string().guid().required(), documentId: Joi.string().guid().required() })
};

export function createCustomerAccountsRouter({ service = createCustomerAccountsService() } = {}) {
  const router = Router({ mergeParams: true });
  const base = "/:tenantCode/stores/:storeCode/account";
  router.use(base, async (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Pragma": "no-cache" });
    validate(Joi.object({ tenantCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required(), storeCode: Joi.string().pattern(/^[A-Za-z0-9_-]{1,60}$/).required() }), req.params);
    req.customerScope = await service.scope(req.params);
    req.customerToken = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] || "";
    if (req.method !== "GET") await service.ipLimit(req.customerScope, req.ip);
    next();
  });
  const data = (res, result) => res.json({ data: result });
  for (const [path, method, schema] of [["register", "register", schemas.register], ["login", "login", schemas.login], ["forgot-password", "forgot", schemas.forgot], ["verify", "verify", schemas.redeem], ["reset-password", "reset", schemas.redeem]]) {
    router.post(`${base}/${path}`, async (req, res) => data(res, await service[method](req.customerScope, validate(schema, req.body))));
  }
  router.get(`${base}/me`, async (req, res) => data(res, await service.me(req.customerScope, req.customerToken)));
  router.post(`${base}/orders/list`, async (req, res) => data(res, await service.orders(req.customerScope, req.customerToken, validate(orderSchemas.list, req.body))));
  router.post(`${base}/orders/read`, async (req, res) => data(res, await service.order(req.customerScope, req.customerToken, validate(orderSchemas.read, req.body))));
  router.post(`${base}/orders/after-sales`, async (req, res) => data(res, await service.afterSales(req.customerScope, req.customerToken, validate(orderSchemas.read, req.body))));
  router.post(`${base}/orders/cancel`, async (req, res) => data(res, await service.cancelOrder(req.customerScope, req.customerToken, validate(orderSchemas.cancel, req.body))));
  router.post(`${base}/orders/return`, async (req, res) => data(res, await service.requestReturn(req.customerScope, req.customerToken, validate(orderSchemas.return, req.body))));
  router.post(`${base}/orders/review`, async (req, res) => data(res, await service.review(req.customerScope, req.customerToken, validate(orderSchemas.review, req.body))));
  router.post(`${base}/orders/invoice`, async (req, res) => {
    const result = await service.invoice(req.customerScope, req.customerToken, validate(orderSchemas.invoice, req.body));
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${result.filename}"`, "X-Content-Type-Options": "nosniff" });
    res.send(result.buffer);
  });
  router.post(`${base}/logout`, async (req, res) => data(res, await service.logout(req.customerScope, req.customerToken)));
  router.put(`${base}/profile`, async (req, res) => data(res, await service.updateProfile(req.customerScope, req.customerToken, validate(schemas.profile, req.body))));
  router.post(`${base}/password`, async (req, res) => data(res, await service.changePassword(req.customerScope, req.customerToken, validate(schemas.password, req.body))));
  router.post(`${base}/addresses`, async (req, res) => data(res, await service.address(req.customerScope, req.customerToken, null, validate(schemas.address, req.body))));
  router.put(`${base}/addresses/:addressId`, async (req, res) => data(res, await service.address(req.customerScope, req.customerToken, validate(Joi.string().guid(), req.params.addressId), validate(schemas.address, req.body))));
  router.delete(`${base}/addresses/:addressId`, async (req, res) => data(res, await service.address(req.customerScope, req.customerToken, validate(Joi.string().guid(), req.params.addressId), null, true)));
  return router;
}
