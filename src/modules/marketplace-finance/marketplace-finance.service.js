import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import Decimal from "decimal.js";
import * as defaultDao from "./marketplace-finance.dao.js";

function fail(code, message, status = 422, field = null) {
  throw new AppError({ code, message, status, details: field ? [{ field, code: code.toLowerCase(), message }] : [] });
}

export function createMarketplaceFinanceService({ dao = defaultDao, transaction = withTransaction } = {}) {
  const getWorkspace = (tenantId, filters) => dao.getWorkspace({ tenantId, filters });

  async function saveRule(tenantId, ruleId, input, context) {
    return transaction(tenantId, async (connection) => {
      let beforeData = null; const id = ruleId || createId();
      if (ruleId) { beforeData = await dao.getRule({ tenantId, ruleId, connection, forUpdate: true });
        if (!beforeData) fail("COMMISSION_RULE_NOT_FOUND", "Commission rule was not found.", 404); }
      if (!await dao.scopeExists({ tenantId, input, connection })) {
        fail("COMMISSION_SCOPE_INVALID", "Select a merchant or store from this workspace.", 422,
          input.scopeType === "MERCHANT" ? "merchantId" : "storeId");
      }
      const rule = { ...input, id, tenantId };
      if (ruleId) await dao.updateRule({ ruleId, rule, connection });
      else await dao.insertRule({ rule, connection });
      const afterData = await dao.getRule({ tenantId, ruleId: id, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        entityId: id, action: ruleId ? "commission_rule.updated" : "commission_rule.created",
        requestId: context.requestId, ipAddress: context.ipAddress || null,
        userAgent: context.userAgent?.slice(0, 500) || null, beforeData, afterData }, connection });
      return afterData;
    });
  }

  async function postCompletedOrderLedger(tenantId, orderId, context, connection) {
    const sellerOrders = await dao.listCompletedSellerOrdersForLedger({ tenantId, orderId, connection });
    const posted = [];
    for (const sellerOrder of sellerOrders) {
      if (await dao.sellerOrderLedgerExists({ tenantId, sellerOrderId: sellerOrder.id, connection })) continue;
      const rule = await dao.findEffectiveCommissionRule({ tenantId, sellerOrder, connection });
      const base = new Decimal(rule?.appliesOn === "ORDER_TOTAL" ? sellerOrder.grandTotal
        : rule?.appliesOn === "ITEM_TOTAL" ? sellerOrder.itemTotal : sellerOrder.taxableValue);
      let commission = rule?.commissionType === "FIXED"
        ? new Decimal(rule.commissionAmount || 0)
        : base.times(rule?.commissionRate ?? sellerOrder.defaultCommissionRate).toDecimalPlaces(4);
      if (rule?.minimumCommission !== null && rule?.minimumCommission !== undefined) {
        commission = Decimal.max(commission, new Decimal(rule.minimumCommission));
      }
      if (rule?.maximumCommission !== null && rule?.maximumCommission !== undefined) {
        commission = Decimal.min(commission, new Decimal(rule.maximumCommission));
      }
      commission = Decimal.max(0, Decimal.min(commission, new Decimal(sellerOrder.grandTotal))).toDecimalPlaces(4);
      const commissionGst = commission.times("0.18").toDecimalPlaces(4);
      const gross = new Decimal(sellerOrder.grandTotal).toDecimalPlaces(4);
      const payable = Decimal.max(0, gross.minus(commission).minus(commissionGst)).toDecimalPlaces(4);
      const effectiveAt = sellerOrder.completedAt ? new Date(sellerOrder.completedAt) : new Date();
      const availableAt = new Date(effectiveAt.getTime() + sellerOrder.settlementCycleDays * 86400000);
      const entries = [{ type: "SALE_CREDIT", direction: "CREDIT", amount: gross,
        effect: gross, description: `Sale proceeds for ${sellerOrder.sellerOrderNumber}.` }];
      if (commission.greaterThan(0)) entries.push({ type: "COMMISSION_DEBIT", direction: "DEBIT",
        amount: commission, effect: commission.negated(), description: `Platform commission for ${sellerOrder.sellerOrderNumber}.` });
      if (commissionGst.greaterThan(0)) entries.push({ type: "COMMISSION_GST_DEBIT", direction: "DEBIT",
        amount: commissionGst, effect: commissionGst.negated(), description: `GST on platform commission for ${sellerOrder.sellerOrderNumber}.` });
      for (const entry of entries) await dao.insertLedgerEntry({ entry: { id: createId(), tenantId,
        merchantId: sellerOrder.merchantId, sellerOrderId: sellerOrder.id, entryType: entry.type,
        direction: entry.direction, amount: entry.amount.toFixed(4), balanceEffect: entry.effect.toFixed(4),
        description: entry.description, effectiveAt, availableAt }, connection });
      await dao.updateSellerOrderFinance({ sellerOrderId: sellerOrder.id, commissionTotal: commission.toFixed(4),
        merchantPayableTotal: payable.toFixed(4), connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        entityId: sellerOrder.id, entityType: "SELLER_ORDER", action: "merchant_ledger.posted", requestId: context.requestId,
        ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null,
        beforeData: null, afterData: { gross: gross.toFixed(4), commission: commission.toFixed(4),
          commissionGst: commissionGst.toFixed(4), payable: payable.toFixed(4), ruleId: rule?.id || null } }, connection });
      posted.push(sellerOrder.id);
    }
    return posted;
  }

  async function reconcileLedger(tenantId, context) {
    return transaction(tenantId, async (connection) => {
      const orderIds = await dao.listEligibleOrderIds({ tenantId, connection }); const sellerOrderIds = [];
      for (const orderId of orderIds) {
        sellerOrderIds.push(...await postCompletedOrderLedger(tenantId, orderId, context, connection));
      }
      return { eligibleOrders: orderIds.length, postedSellerOrders: sellerOrderIds.length,
        sellerOrderIds, hasMore: orderIds.length === 100 };
    });
  }

  return { getWorkspace, postCompletedOrderLedger, reconcileLedger,
    createRule: (tenantId, input, context) => saveRule(tenantId, null, input, context),
    updateRule: (tenantId, ruleId, input, context) => saveRule(tenantId, ruleId, input, context) };
}

const service = createMarketplaceFinanceService();
export const { getWorkspace, createRule, updateRule, postCompletedOrderLedger, reconcileLedger } = service;
