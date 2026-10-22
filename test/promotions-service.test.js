import assert from "node:assert/strict";
import test from "node:test";
import { createPromotionsService } from "../src/modules/promotions/promotions.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const promotionId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const actor = { actorUserId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77", requestId: "promotion-test",
  ipAddress: "127.0.0.1", userAgent: "test" };
const transaction = async (_tenantId, operation) => operation({});

test("percentage preview respects maximum discount", async () => {
  const service = createPromotionsService({ transaction, dao: {
    async getPromotionDetails() { return { promotion: { id: promotionId, type: "PERCENTAGE",
      discountValue: 20, maxDiscountAmount: 250, minimumOrderAmount: 500, couponRequired: false }, coupons: [], redemptions: [] }; }
  } });
  const result = await service.previewPromotion(tenantId, promotionId, { subtotal: 2000, shippingAmount: 50, couponCode: "" });
  assert.equal(result.eligible, true); assert.equal(result.discountAmount, 250); assert.equal(result.payableAmount, 1800);
});

test("preview explains minimum order failure", async () => {
  const service = createPromotionsService({ transaction, dao: {
    async getPromotionDetails() { return { promotion: { id: promotionId, type: "FIXED_AMOUNT",
      discountValue: 200, minimumOrderAmount: 1000, couponRequired: false }, coupons: [], redemptions: [] }; }
  } });
  const result = await service.previewPromotion(tenantId, promotionId, { subtotal: 500, shippingAmount: 0, couponCode: "" });
  assert.equal(result.eligible, false); assert.match(result.reason, /at least/);
});

test("coupon-required preview validates active coupon limits", async () => {
  const service = createPromotionsService({ transaction, dao: {
    async getPromotionDetails() { return { promotion: { id: promotionId, type: "FIXED_AMOUNT",
      discountValue: 100, minimumOrderAmount: 0, couponRequired: true }, coupons: [], redemptions: [] }; },
    async findCouponByCode() { return { code: "SAVE100", status: "ACTIVE", usageLimit: 10, usageCount: 10 }; }
  } });
  const result = await service.previewPromotion(tenantId, promotionId, { subtotal: 500, shippingAmount: 0, couponCode: "SAVE100" });
  assert.equal(result.eligible, false); assert.match(result.reason, /usage limit/);
});

test("promotion activation is transactional and audited", async () => {
  let status; let audit;
  const dao = { async getPromotion() { return { id: promotionId, storedStatus: "DRAFT", endsAt: null }; },
    async setPromotionStatus(value) { status = value.status; return true; },
    async insertAudit(value) { audit = value.audit; },
    async getPromotionDetails() { return { promotion: { id: promotionId, status: "ACTIVE" }, coupons: [], redemptions: [] }; } };
  const service = createPromotionsService({ dao, transaction });
  const result = await service.transitionPromotion(tenantId, promotionId, "ACTIVE", actor);
  assert.equal(status, "ACTIVE"); assert.equal(audit.action, "PROMOTION_ACTIVATED"); assert.equal(result.promotion.status, "ACTIVE");
});

test("expired promotions cannot be activated", async () => {
  const service = createPromotionsService({ transaction, dao: { async getPromotion() {
    return { id: promotionId, storedStatus: "PAUSED", endsAt: "2020-01-01T00:00:00.000Z" };
  } } });
  await assert.rejects(() => service.transitionPromotion(tenantId, promotionId, "ACTIVE", actor),
    (error) => error.code === "PROMOTION_EXPIRED" && error.status === 409);
});
