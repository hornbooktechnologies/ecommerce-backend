import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import * as defaultService from "./returns.service.js";
import { createReturnsController } from "./returns.controller.js";
import { completeExchangeSchema, completeReturnSchema, createExchangeSchema, createReturnSchema,
  decisionSchema, exchangeIdSchema, inspectReturnSchema, listReturnsSchema, receiveReturnSchema,
  rejectReturnSchema, returnIdSchema, validateBody, validateParams, validateQuery } from "./returns.validators.js";

export function createReturnsRouter({ returnsService = defaultService, resolveTenant = resolveTenantAccess,
  authorize = requirePermission } = {}) {
  const router = Router();
  const controller = createReturnsController(returnsService);
  router.use(authenticate, resolveTenant);
  router.get("/returns/options", authorize("return.manage"), controller.options);
  router.get("/returns", authorize("return.read"), validateQuery(listReturnsSchema), controller.list);
  router.post("/returns", authorize("return.manage"), validateBody(createReturnSchema), controller.create);
  router.get("/returns/:returnId", authorize("return.read"), validateParams(returnIdSchema), controller.get);
  router.post("/returns/:returnId/approve", authorize("return.manage"), validateParams(returnIdSchema), validateBody(decisionSchema), controller.approve);
  router.post("/returns/:returnId/reject", authorize("return.manage"), validateParams(returnIdSchema), validateBody(rejectReturnSchema), controller.reject);
  router.post("/returns/:returnId/receive", authorize("return.manage"), validateParams(returnIdSchema), validateBody(receiveReturnSchema), controller.receive);
  router.post("/returns/:returnId/inspect", authorize("return.manage"), validateParams(returnIdSchema), validateBody(inspectReturnSchema), controller.inspect);
  router.post("/returns/:returnId/complete", authorize("return.manage"), validateParams(returnIdSchema), validateBody(completeReturnSchema), controller.complete);
  router.post("/returns/:returnId/exchanges", authorize("return.manage"), validateParams(returnIdSchema), validateBody(createExchangeSchema), controller.createExchange);
  router.post("/exchanges/:exchangeId/complete", authorize("return.manage"), validateParams(exchangeIdSchema), validateBody(completeExchangeSchema), controller.completeExchange);
  return router;
}

