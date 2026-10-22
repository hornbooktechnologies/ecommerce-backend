import assert from "node:assert/strict";
import test from "node:test";
import { createMarketplaceFinanceService } from "../src/modules/marketplace-finance/marketplace-finance.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const orderId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const context = { actorUserId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77",
  requestId: "request-1", ipAddress: "127.0.0.1", userAgent: "test" };

test("completed vendor orders post immutable sale, commission, and GST ledger entries", async () => {
  const entries = []; let totals; let audit;
  const service = createMarketplaceFinanceService({ dao: {
    async listCompletedSellerOrdersForLedger() { return [{ id: orderId, merchantId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b55",
      sellerOrderNumber: "RET-SO-0001", storeId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b44",
      grandTotal: 1180, taxableValue: 1000, itemTotal: 1180, completedAt: "2026-10-22T04:00:00.000Z",
      defaultCommissionRate: 0.08, settlementCycleDays: 7 }]; },
    async sellerOrderLedgerExists() { return false; },
    async findEffectiveCommissionRule() { return { id: "rule", commissionType: "PERCENTAGE",
      commissionRate: 0.1, commissionAmount: null, minimumCommission: null,
      maximumCommission: null, appliesOn: "TAXABLE_VALUE" }; },
    async insertLedgerEntry({ entry }) { entries.push(entry); },
    async updateSellerOrderFinance(value) { totals = value; },
    async insertAudit({ audit: value }) { audit = value; }
  } });
  const posted = await service.postCompletedOrderLedger(tenantId, orderId, context, {});
  assert.deepEqual(posted, [orderId]);
  assert.deepEqual(entries.map((entry) => [entry.entryType, entry.amount, entry.balanceEffect]), [
    ["SALE_CREDIT", "1180.0000", "1180.0000"],
    ["COMMISSION_DEBIT", "100.0000", "-100.0000"],
    ["COMMISSION_GST_DEBIT", "18.0000", "-18.0000"]
  ]);
  assert.equal(totals.commissionTotal, "100.0000"); assert.equal(totals.merchantPayableTotal, "1062.0000");
  assert.equal(audit.entityType, "SELLER_ORDER"); assert.equal(audit.afterData.ruleId, "rule");
});

test("ledger posting is idempotent for an already-posted seller order", async () => {
  let inserted = false;
  const service = createMarketplaceFinanceService({ dao: {
    async listCompletedSellerOrdersForLedger() { return [{ id: orderId }]; },
    async sellerOrderLedgerExists() { return true; },
    async insertLedgerEntry() { inserted = true; }
  } });
  const posted = await service.postCompletedOrderLedger(tenantId, orderId, context, {});
  assert.deepEqual(posted, []); assert.equal(inserted, false);
});
