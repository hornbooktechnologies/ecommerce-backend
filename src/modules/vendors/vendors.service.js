import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { hashPassword } from "../../core/security/password.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./vendors.dao.js";

function fail(code, message, status = 422, field = null) {
  throw new AppError({ code, message, status,
    details: field ? [{ field, code: code.toLowerCase(), message }] : [] });
}

export function createVendorsService({ dao = defaultDao, transaction = withTransaction,
  passwordHasher = hashPassword } = {}) {
  async function requireVendor(tenantId, vendorId, connection, forUpdate = false) {
    const result = await dao.getVendor({ tenantId, vendorId, connection, forUpdate });
    if (!result) fail("VENDOR_NOT_FOUND", "Vendor was not found.", 404);
    return result;
  }

  async function audit(tenantId, entityId, action, beforeData, afterData, context, connection, entityType = "VENDOR") {
    await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
      action, entityType, entityId, requestId: context.requestId, ipAddress: context.ipAddress,
      userAgent: context.userAgent, beforeData, afterData }, connection });
  }

  async function listVendors(tenantId, filters) { return dao.listVendors({ tenantId, filters }); }
  async function listVendorOptions(tenantId, filters) {
    return dao.listVendorOptions({ tenantId, variantSearch: filters.variantSearch });
  }
  async function getVendor(tenantId, vendorId) { return requireVendor(tenantId, vendorId); }

  async function createVendor(tenantId, input, context) {
    return transaction(tenantId, async (connection) => {
      const duplicates = await dao.findVendorDuplicates({ tenantId, code: input.merchantCode,
        pan: input.pan, gstin: input.gstin, connection });
      if (duplicates.code) fail("VENDOR_CODE_EXISTS", "This vendor code is already in use.", 409, "merchantCode");
      if (duplicates.pan) fail("VENDOR_PAN_EXISTS", "This PAN is already linked to another merchant.", 409, "pan");
      if (duplicates.gstin) fail("VENDOR_GSTIN_EXISTS", "This GSTIN is already registered.", 409, "gstin");
      const stores = await dao.findActiveStores({ tenantId, storeIds: input.storeIds, connection });
      if (stores.length !== input.storeIds.length) fail("VENDOR_STORE_INVALID", "Select only active stores from this workspace.", 422, "storeIds");
      const id = createId(); const addressId = createId();
      await dao.insertAddress({ address: { id: addressId, tenantId, contactName: input.contactPerson,
        companyName: input.legalName, phone: input.supportPhone, ...input.address }, connection });
      await dao.insertVendor({ vendor: { id, tenantId, addressId, gstId: createId(), ...input,
        stateCode: input.address.stateCode,
        defaultCommissionRate: input.defaultCommissionPercent / 100 }, connection });
      await audit(tenantId, id, "vendor.created", null, { merchantCode: input.merchantCode,
        status: "PENDING", storeIds: input.storeIds }, context, connection);
      return dao.getVendor({ tenantId, vendorId: id, connection });
    });
  }

  async function updateVendor(tenantId, vendorId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await requireVendor(tenantId, vendorId, connection, true);
      if (input.storeIds) {
        const stores = await dao.findActiveStores({ tenantId, storeIds: input.storeIds, connection });
        if (stores.length !== input.storeIds.length) fail("VENDOR_STORE_INVALID", "Select only active stores from this workspace.", 422, "storeIds");
      }
      const changes = { ...input };
      if (input.defaultCommissionPercent !== undefined) {
        changes.defaultCommissionRate = input.defaultCommissionPercent / 100;
        delete changes.defaultCommissionPercent;
      }
      await dao.updateVendor({ tenantId, vendorId, changes, connection });
      await audit(tenantId, vendorId, "vendor.updated", { displayName: current.vendor.displayName },
        { changedFields: Object.keys(input) }, context, connection);
      return dao.getVendor({ tenantId, vendorId, connection });
    });
  }

  async function transitionVendor(tenantId, vendorId, expectedStatuses, status, onboardingStatus, action, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await requireVendor(tenantId, vendorId, connection, true);
      if (!expectedStatuses.includes(current.vendor.status)) {
        fail("VENDOR_STATUS_INVALID", `A ${current.vendor.status.toLowerCase()} vendor cannot be ${action.split(".")[1]}.`, 409);
      }
      await dao.updateVendorStatus({ tenantId, vendorId, status, onboardingStatus,
        actorUserId: context.actorUserId, connection });
      await audit(tenantId, vendorId, action, { status: current.vendor.status },
        { status, notes: input.notes }, context, connection);
      return dao.getVendor({ tenantId, vendorId, connection });
    });
  }

  const approveVendor = (tenantId, vendorId, input, context) => transitionVendor(tenantId, vendorId,
    ["PENDING"], "ACTIVE", "APPROVED", "vendor.approved", input, context);
  const suspendVendor = (tenantId, vendorId, input, context) => transitionVendor(tenantId, vendorId,
    ["ACTIVE"], "SUSPENDED", "SUSPENDED", "vendor.suspended", input, context);
  const restoreVendor = (tenantId, vendorId, input, context) => transitionVendor(tenantId, vendorId,
    ["SUSPENDED"], "ACTIVE", "APPROVED", "vendor.restored", input, context);

  async function inviteVendorUser(tenantId, vendorId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await requireVendor(tenantId, vendorId, connection, true);
      if (current.vendor.status !== "ACTIVE") {
        fail("VENDOR_APPROVAL_REQUIRED", "Approve the vendor before creating portal access.", 409);
      }
      const email = input.email.trim().toLowerCase();
      if (await dao.findUserByEmail({ email, connection })) {
        fail("VENDOR_USER_EXISTS", "A user account already exists for this email address.", 409, "email");
      }
      const role = await dao.findVendorRole({ tenantId, roleKey: input.roleKey, connection });
      if (!role) fail("VENDOR_ROLE_MISSING", "The selected vendor role is not configured.", 409);
      const userId = createId();
      await dao.insertVendorUser({ user: { id: userId, email, firstName: input.firstName,
        lastName: input.lastName, passwordHash: await passwordHasher(input.temporaryPassword) }, connection });
      await dao.insertVendorMembership({ membership: { id: createId(), tenantId, userId,
        invitedBy: context.actorUserId }, connection });
      await dao.insertVendorAssignment({ assignment: { id: createId(), tenantId, userId,
        roleId: role.id, vendorId, assignedBy: context.actorUserId }, connection });
      await audit(tenantId, userId, "vendor.user.created", null, { vendorId, email,
        roleKey: input.roleKey }, context, connection, "USER");
      return { id: userId, email, status: "ACTIVE", vendorId, roleKey: input.roleKey };
    });
  }

  async function createVendorOffer(tenantId, vendorId, input, context) {
    return transaction(tenantId, async (connection) => {
      if (input.salePrice > input.listPrice) fail("OFFER_PRICE_INVALID", "Selling price cannot exceed MRP.", 422, "salePrice");
      const offerContext = await dao.findOfferContext({ tenantId, vendorId, storeId: input.storeId,
        variantId: input.variantId, connection });
      if (!offerContext) fail("OFFER_SCOPE_INVALID", "Select an assigned store and an active catalog variant.", 422);
      if (offerContext.merchantStatus !== "ACTIVE") fail("VENDOR_APPROVAL_REQUIRED", "Approve the vendor before adding catalog offers.", 409);
      if (await dao.findDuplicateOffer({ storeId: input.storeId, vendorId, variantId: input.variantId,
        sellerSku: input.sellerSku, connection })) {
        fail("VENDOR_OFFER_EXISTS", "This product variant or seller SKU is already assigned in the selected store.", 409, "variantId");
      }
      const offerId = createId();
      await dao.insertVendorOffer({ offer: { id: offerId, tenantId, vendorId,
        storeId: input.storeId, variantId: input.variantId, sellerSku: input.sellerSku,
        fulfillmentType: input.fulfillmentType, handlingTimeHours: input.handlingTimeHours,
        taxCategoryId: offerContext.taxCategoryId, actorUserId: context.actorUserId },
      price: { id: createId(), tenantId, offerId, priceListId: offerContext.priceListId,
        listPrice: input.listPrice, salePrice: input.salePrice, costPrice: input.costPrice }, connection });
      await audit(tenantId, offerId, "vendor.offer.created", null, { vendorId,
        storeId: input.storeId, variantId: input.variantId, salePrice: input.salePrice },
      context, connection, "SELLER_OFFER");
      return dao.getVendor({ tenantId, vendorId, connection });
    });
  }

  async function updateVendorOffer(tenantId, vendorId, offerId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await dao.findVendorOffer({ tenantId, vendorId, offerId, connection, forUpdate: true });
      if (!current) fail("VENDOR_OFFER_NOT_FOUND", "Vendor offer was not found.", 404);
      const listPrice = input.listPrice ?? current.listPrice;
      const salePrice = input.salePrice ?? current.salePrice;
      const costPrice = input.costPrice !== undefined ? input.costPrice : current.costPrice;
      if (salePrice > listPrice) fail("OFFER_PRICE_INVALID", "Selling price cannot exceed MRP.", 422, "salePrice");
      await dao.updateVendorOffer({ offerId, status: input.status,
        handlingTimeHours: input.handlingTimeHours, connection });
      const priceChanged = input.listPrice !== undefined || input.salePrice !== undefined || input.costPrice !== undefined;
      if (priceChanged) {
        if (!current.priceListId) fail("OFFER_PRICE_LIST_MISSING", "The offer does not have an active INR price list.", 409);
        await dao.closeOfferPrice({ offerId, priceListId: current.priceListId, connection });
        await dao.insertOfferPrice({ price: { id: createId(), tenantId, offerId,
          priceListId: current.priceListId, listPrice, salePrice, costPrice }, connection });
      }
      await audit(tenantId, offerId, "vendor.offer.updated", { status: current.status,
        listPrice: current.listPrice, salePrice: current.salePrice }, { ...input },
      context, connection, "SELLER_OFFER");
      return dao.getVendor({ tenantId, vendorId, connection });
    });
  }

  return { listVendors, listVendorOptions, getVendor, createVendor, updateVendor,
    approveVendor, suspendVendor, restoreVendor, inviteVendorUser, createVendorOffer, updateVendorOffer };
}

const service = createVendorsService();
export const listVendors = service.listVendors;
export const listVendorOptions = service.listVendorOptions;
export const getVendor = service.getVendor;
export const createVendor = service.createVendor;
export const updateVendor = service.updateVendor;
export const approveVendor = service.approveVendor;
export const suspendVendor = service.suspendVendor;
export const restoreVendor = service.restoreVendor;
export const inviteVendorUser = service.inviteVendorUser;
export const createVendorOffer = service.createVendorOffer;
export const updateVendorOffer = service.updateVendorOffer;
