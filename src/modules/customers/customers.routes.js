import { Router } from "express";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import { authenticate } from "../auth/auth.middleware.js";
import * as defaultService from "./customers.service.js";
import { createCustomersController } from "./customers.controller.js";
import { customerParamsSchema, listCustomersSchema, updateCustomerSchema,
  validateBody, validateParams, validateQuery } from "./customers.validators.js";

export function createCustomersRouter({ customersService = defaultService,
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router();
  const controller = createCustomersController(customersService);
  router.use(authenticate, resolveTenant);
  router.get("/customers", authorize("customer.read"), validateQuery(listCustomersSchema), controller.list);
  router.get("/customers/:customerId", authorize("customer.read"),
    validateParams(customerParamsSchema), controller.get);
  router.patch("/customers/:customerId", authorize("customer.manage"),
    validateParams(customerParamsSchema), validateBody(updateCustomerSchema), controller.update);
  return router;
}
