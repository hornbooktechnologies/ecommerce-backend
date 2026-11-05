import { raw, Router } from "express";
import * as sellerProfiles from '../seller-profiles/seller-profiles.service.js';
import {params as sellerProfileParams,update as sellerProfileUpdate} from '../seller-profiles/seller-profiles.validators.js';
import {validate as sellerProfileValidate} from '../customer-accounts/customer-accounts.validators.js';
import { authenticate } from "../auth/auth.middleware.js";
import { requirePermission, resolveTenantAccess } from "../access-control/access-control.middleware.js";
import * as defaultService from "./vendors.service.js";
import { createVendorsController } from "./vendors.controller.js";
import { createVendorOfferSchema, createVendorSchema, inviteVendorUserSchema, listVendorsSchema, updateVendorOfferSchema,
  updateVendorSchema, uploadVendorDocumentSchema, uploadVendorLogoSchema, validateBody, validateParams,
  validateQuery, vendorDecisionSchema, vendorDocumentDecisionSchema, vendorDocumentIdSchema,
  vendorIdSchema, vendorOfferIdSchema, vendorOptionsSchema } from "./vendors.validators.js";

export function createVendorsRouter({ vendorsService = defaultService, resolveTenant = resolveTenantAccess,
  authorize = requirePermission } = {}) {
  const router = Router();
  const controller = createVendorsController(vendorsService);
  router.use(authenticate, resolveTenant);
  const sellerArgs=req=>{const input=sellerProfileValidate(sellerProfileParams,req.params);return {tenantId:req.context.tenant.tenantId,merchantId:input.vendorId,storeId:input.storeId};};
  router.get('/vendors/:vendorId/stores/:storeId/public-profile',authorize('vendor.read'),async(req,res)=>{res.set('Cache-Control','no-store');res.json({data:await sellerProfiles.readAdmin(sellerArgs(req))});});
  router.put('/vendors/:vendorId/stores/:storeId/public-profile',authorize('vendor.read'),authorize('vendor.manage'),async(req,res)=>{res.set('Cache-Control','no-store');res.json({data:await sellerProfiles.updateAdmin(sellerArgs(req),sellerProfileValidate(sellerProfileUpdate,req.body),{actorUserId:req.context.actor.userId,requestId:req.context.requestId,ipAddress:req.ip,userAgent:req.get('user-agent')||null})});});
  router.get("/vendors/options", authorize("vendor.manage"), validateQuery(vendorOptionsSchema), controller.options);
  router.get("/vendors", authorize("vendor.read"), validateQuery(listVendorsSchema), controller.list);
  router.post("/vendors", authorize("vendor.manage"), validateBody(createVendorSchema), controller.create);
  router.get("/vendors/:vendorId", authorize("vendor.read"), validateParams(vendorIdSchema), controller.get);
  router.patch("/vendors/:vendorId", authorize("vendor.manage"), validateParams(vendorIdSchema), validateBody(updateVendorSchema), controller.update);
  router.put("/vendors/:vendorId/logo", authorize("vendor.manage"), validateParams(vendorIdSchema),
    validateQuery(uploadVendorLogoSchema), raw({ type: () => true, limit: "3mb" }), controller.uploadLogo);
  router.post("/vendors/:vendorId/documents/upload", authorize("vendor.manage"), validateParams(vendorIdSchema),
    validateQuery(uploadVendorDocumentSchema), raw({ type: () => true, limit: "10mb" }), controller.uploadDocument);
  router.get("/vendors/:vendorId/documents/:documentId/file", authorize("vendor.read"),
    validateParams(vendorDocumentIdSchema), controller.downloadDocument);
  router.post("/vendors/:vendorId/documents/:documentId/decision", authorize("vendor.manage"),
    validateParams(vendorDocumentIdSchema), validateBody(vendorDocumentDecisionSchema), controller.decideDocument);
  router.post("/vendors/:vendorId/approve", authorize("vendor.manage"), validateParams(vendorIdSchema), validateBody(vendorDecisionSchema), controller.approve);
  router.post("/vendors/:vendorId/suspend", authorize("vendor.manage"), validateParams(vendorIdSchema), validateBody(vendorDecisionSchema), controller.suspend);
  router.post("/vendors/:vendorId/restore", authorize("vendor.manage"), validateParams(vendorIdSchema), validateBody(vendorDecisionSchema), controller.restore);
  router.post("/vendors/:vendorId/invitations", authorize("vendor.manage"), validateParams(vendorIdSchema), validateBody(inviteVendorUserSchema), controller.inviteUser);
  router.post("/vendors/:vendorId/offers", authorize("vendor.manage"), validateParams(vendorIdSchema), validateBody(createVendorOfferSchema), controller.createOffer);
  router.patch("/vendors/:vendorId/offers/:offerId", authorize("vendor.manage"), validateParams(vendorOfferIdSchema), validateBody(updateVendorOfferSchema), controller.updateOffer);
  return router;
}
