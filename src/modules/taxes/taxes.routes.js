import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import * as defaultService from "./taxes.service.js";
import { createTaxesController } from "./taxes.controller.js";
import { categoryParamsSchema, createCategorySchema, createInvoiceSeriesSchema, createRateSchema,
  createRegistrationSchema, documentParamsSchema, invoiceSeriesParamsSchema, rateParamsSchema, registrationParamsSchema,
  issueTaxInvoiceSchema, updateCategorySchema, updateInvoiceSeriesSchema, updateRateSchema, updateRegistrationSchema,
  validateBody, validateParams } from "./taxes.validators.js";

export function createTaxesRouter({ taxesService = defaultService,
  resolveTenant = resolveTenantAccess, authorize = requirePermission } = {}) {
  const router = Router();
  const controller = createTaxesController(taxesService);
  router.use(authenticate, resolveTenant);
  router.get("/taxes", authorize("tax.read"), controller.getWorkspace);
  router.post("/taxes/registrations", authorize("tax.manage"), validateBody(createRegistrationSchema), controller.createRegistration);
  router.patch("/taxes/registrations/:registrationId", authorize("tax.manage"), validateParams(registrationParamsSchema), validateBody(updateRegistrationSchema), controller.updateRegistration);
  router.post("/taxes/categories", authorize("tax.manage"), validateBody(createCategorySchema), controller.createCategory);
  router.patch("/taxes/categories/:categoryId", authorize("tax.manage"), validateParams(categoryParamsSchema), validateBody(updateCategorySchema), controller.updateCategory);
  router.post("/taxes/categories/:categoryId/rates", authorize("tax.manage"), validateParams(categoryParamsSchema), validateBody(createRateSchema), controller.createRate);
  router.patch("/taxes/rates/:rateId", authorize("tax.manage"), validateParams(rateParamsSchema), validateBody(updateRateSchema), controller.updateRate);
  router.post("/taxes/invoice-series", authorize("tax.manage"), validateBody(createInvoiceSeriesSchema), controller.createInvoiceSeries);
  router.patch("/taxes/invoice-series/:seriesId", authorize("tax.manage"), validateParams(invoiceSeriesParamsSchema), validateBody(updateInvoiceSeriesSchema), controller.updateInvoiceSeries);
  router.post("/taxes/documents", authorize("tax.manage"), validateBody(issueTaxInvoiceSchema), controller.issueTaxInvoice);
  router.get("/taxes/documents/:documentId", authorize("tax.read"), validateParams(documentParamsSchema), controller.getTaxDocument);
  router.get("/taxes/documents/:documentId/pdf", authorize("tax.read"), validateParams(documentParamsSchema), controller.getTaxDocumentPdf);
  return router;
}
