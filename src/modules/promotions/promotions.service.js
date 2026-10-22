import Decimal from "decimal.js";
import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./promotions.dao.js";

const fail = (code, message, status = 400, field) => { throw new AppError({ code, message, status,
  details: field ? [{ field, code, message }] : [] }); };
const missing = () => new AppError({ code: "PROMOTION_NOT_FOUND", message: "The promotion was not found.", status: 404 });
const contextData = (input) => ({ ...input, conditions: { minimumOrderAmount: input.minimumOrderAmount, couponRequired: input.couponRequired },
  actions: { discountValue: input.discountValue, maxDiscountAmount: input.maxDiscountAmount } });
function auditRecord(context, tenantId, entityId, action, entityType, beforeData, afterData) {
  return { id: createId(), tenantId, actorUserId: context.actorUserId, action, entityType, entityId,
    requestId: context.requestId, ipAddress: context.ipAddress || "127.0.0.1", userAgent: context.userAgent,
    beforeData, afterData };
}
function duplicateCoupon(error) {
  if (error?.code === "ER_DUP_ENTRY") return new AppError({ code: "COUPON_CODE_EXISTS",
    message: "This coupon code is already used in the workspace.", status: 409,
    details: [{ field: "code", code: "COUPON_CODE_EXISTS", message: "Enter a unique coupon code." }] });
  return error;
}

export function createPromotionsService({ dao = defaultDao, transaction = withTransaction } = {}) {
  const listPromotions = (tenantId, filters) => dao.listPromotions({ tenantId, filters });
  const listOptions = (tenantId) => dao.listOptions({ tenantId });
  async function getPromotion(tenantId, promotionId) {
    const details = await dao.getPromotionDetails({ tenantId, promotionId }); if (!details) throw missing(); return details;
  }
  async function createPromotion(tenantId, input, context) {
    const id = createId(); const record = contextData(input);
    await transaction(tenantId, async (connection) => {
      if (!await dao.storeExists({ tenantId, storeId: input.storeId, connection })) fail("STORE_NOT_FOUND", "Select an active store in this workspace.", 422, "storeId");
      await dao.insertPromotion({ promotion: { id, tenantId, ...record, createdBy: context.actorUserId }, connection });
      await dao.insertAudit({ audit: auditRecord(context, tenantId, id, "PROMOTION_CREATED", "PROMOTION", null, input), connection });
    });
    return getPromotion(tenantId, id);
  }
  async function updatePromotion(tenantId, promotionId, input, context) {
    await transaction(tenantId, async (connection) => {
      const current = await dao.getPromotion({ tenantId, promotionId, connection, forUpdate: true }); if (!current) throw missing();
      if (!await dao.storeExists({ tenantId, storeId: input.storeId, connection })) fail("STORE_NOT_FOUND", "Select an active store in this workspace.", 422, "storeId");
      await dao.updatePromotion({ promotionId, input: contextData(input), connection });
      await dao.insertAudit({ audit: auditRecord(context, tenantId, promotionId, "PROMOTION_UPDATED", "PROMOTION", current, input), connection });
    });
    return getPromotion(tenantId, promotionId);
  }
  async function transitionPromotion(tenantId, promotionId, status, context) {
    await transaction(tenantId, async (connection) => {
      const current = await dao.getPromotion({ tenantId, promotionId, connection, forUpdate: true }); if (!current) throw missing();
      if (status === "ACTIVE" && current.endsAt && new Date(current.endsAt) <= new Date()) fail("PROMOTION_EXPIRED", "Extend the promotion end date before activating it.", 409);
      await dao.setPromotionStatus({ promotionId, status, connection });
      await dao.insertAudit({ audit: auditRecord(context, tenantId, promotionId, status === "ACTIVE" ? "PROMOTION_ACTIVATED" : "PROMOTION_PAUSED", "PROMOTION", { status: current.storedStatus }, { status }), connection });
    });
    return getPromotion(tenantId, promotionId);
  }
  async function createCoupon(tenantId, promotionId, input, context) {
    const id = createId();
    try {
      await transaction(tenantId, async (connection) => {
        if (!await dao.getPromotion({ tenantId, promotionId, connection, forUpdate: true })) throw missing();
        await dao.insertCoupon({ coupon: { id, tenantId, promotionId, ...input }, connection });
        await dao.insertAudit({ audit: auditRecord(context, tenantId, id, "COUPON_CREATED", "COUPON", null, { promotionId, ...input }), connection });
      });
    } catch (error) { throw duplicateCoupon(error); }
    return getPromotion(tenantId, promotionId);
  }
  async function updateCoupon(tenantId, promotionId, couponId, input, context) {
    try {
      await transaction(tenantId, async (connection) => {
        const current = await dao.getCoupon({ tenantId, promotionId, couponId, connection, forUpdate: true });
        if (!current) fail("COUPON_NOT_FOUND", "The coupon code was not found.", 404);
        await dao.updateCoupon({ couponId, input, connection });
        await dao.insertAudit({ audit: auditRecord(context, tenantId, couponId, "COUPON_UPDATED", "COUPON", current, input), connection });
      });
    } catch (error) { throw duplicateCoupon(error); }
    return getPromotion(tenantId, promotionId);
  }
  async function previewPromotion(tenantId, promotionId, input) {
    const details = await getPromotion(tenantId, promotionId); const promotion = details.promotion;
    const subtotal = new Decimal(input.subtotal); const shipping = new Decimal(input.shippingAmount);
    const minimum = new Decimal(promotion.minimumOrderAmount || 0);
    if (promotion.usageLimitTotal && promotion.redemptionCount >= promotion.usageLimitTotal) return { eligible: false,
      reason: "This promotion has reached its total usage limit.", subtotal: subtotal.toNumber(),
      shippingAmount: shipping.toNumber(), discountAmount: 0, payableAmount: subtotal.plus(shipping).toNumber() };
    if (subtotal.lessThan(minimum)) return { eligible: false, reason: `Order subtotal must be at least ₹${minimum.toFixed(2)}.`, subtotal: subtotal.toNumber(), shippingAmount: shipping.toNumber(), discountAmount: 0, payableAmount: subtotal.plus(shipping).toNumber() };
    let coupon = null;
    if (promotion.couponRequired) {
      if (!input.couponCode) return { eligible: false, reason: "Enter an active coupon code for this promotion.", subtotal: subtotal.toNumber(), shippingAmount: shipping.toNumber(), discountAmount: 0, payableAmount: subtotal.plus(shipping).toNumber() };
      coupon = await dao.findCouponByCode({ tenantId, promotionId, code: input.couponCode });
      const now = Date.now(); const valid = coupon && coupon.status === "ACTIVE" && (!coupon.startsAt || new Date(coupon.startsAt).getTime() <= now)
        && (!coupon.endsAt || new Date(coupon.endsAt).getTime() >= now) && (!coupon.usageLimit || coupon.usageCount < coupon.usageLimit);
      if (!valid) return { eligible: false, reason: "This coupon is inactive, expired, or has reached its usage limit.", subtotal: subtotal.toNumber(), shippingAmount: shipping.toNumber(), discountAmount: 0, payableAmount: subtotal.plus(shipping).toNumber() };
    }
    let discount = new Decimal(0);
    if (promotion.type === "PERCENTAGE") { discount = subtotal.mul(promotion.discountValue).div(100); if (promotion.maxDiscountAmount) discount = Decimal.min(discount, promotion.maxDiscountAmount); }
    if (promotion.type === "FIXED_AMOUNT") discount = Decimal.min(subtotal, promotion.discountValue);
    if (promotion.type === "FREE_SHIPPING") discount = shipping;
    return { eligible: true, reason: "Promotion is eligible for this order preview.", couponCode: coupon?.code || null,
      subtotal: subtotal.toNumber(), shippingAmount: shipping.toNumber(), discountAmount: discount.toDecimalPlaces(2).toNumber(),
      payableAmount: subtotal.plus(shipping).minus(discount).toDecimalPlaces(2).toNumber() };
  }
  return { listPromotions, listOptions, getPromotion, createPromotion, updatePromotion, transitionPromotion,
    createCoupon, updateCoupon, previewPromotion };
}

const service = createPromotionsService();
export const { listPromotions, listOptions, getPromotion, createPromotion, updatePromotion, transitionPromotion,
  createCoupon, updateCoupon, previewPromotion } = service;
