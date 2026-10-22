import assert from "node:assert/strict";
import test from "node:test";
import { createProcurementService } from "../src/modules/procurement/procurement.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const supplierId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b11";
const warehouseId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b22";
const offerId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b33";
const orderId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b44";
const context = { actorUserId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77", requestId: "request-1" };
const transaction = (_tenantId, operation) => operation({});

test("creates a draft INR purchase order with server-calculated totals", async () => {
  const calls = { order: null, items: [], audit: 0, outbox: 0 };
  const dao = {
    async findOrderScope() { return { validOfferIds: [offerId] }; },
    async insertPurchaseOrder(input) { calls.order = input.order; },
    async insertPurchaseOrderItem(input) { calls.items.push(input.item); },
    async insertAudit() { calls.audit += 1; }, async insertOutbox() { calls.outbox += 1; },
    async findPurchaseOrder({ purchaseOrderId }) { return { id: purchaseOrderId, status: "DRAFT" }; }
  };
  const service = createProcurementService({ dao, transaction });
  const result = await service.createPurchaseOrder(tenantId, { supplierId, warehouseId,
    expectedAt: null, notes: "Weekly replenishment", items: [{ offerId, quantity: 2, unitCost: 100, taxRate: 18 }] }, context);
  assert.equal(result.status, "DRAFT"); assert.equal(calls.order.subtotal, 200);
  assert.equal(calls.order.taxTotal, 36); assert.equal(calls.order.grandTotal, 236);
  assert.equal(calls.items[0].lineTotal, 236); assert.equal(calls.audit, 1); assert.equal(calls.outbox, 1);
});

test("rejects offers outside the receiving warehouse merchant scope", async () => {
  const service = createProcurementService({ transaction, dao: { async findOrderScope() { return { validOfferIds: [] }; } } });
  await assert.rejects(() => service.createPurchaseOrder(tenantId, { supplierId, warehouseId,
    expectedAt: null, notes: "", items: [{ offerId, quantity: 1, unitCost: 100, taxRate: 0 }] }, context),
  (error) => error.code === "PROCUREMENT_OFFER_INVALID" && error.status === 422);
});

test("only a draft purchase order can be approved", async () => {
  const service = createProcurementService({ transaction, dao: {
    async findPurchaseOrder() { return { id: orderId, number: "PO-001", status: "APPROVED" }; }
  } });
  await assert.rejects(() => service.approvePurchaseOrder(tenantId, orderId, context),
    (error) => error.code === "PURCHASE_ORDER_NOT_DRAFT" && error.status === 409);
});

test("approved purchase orders transition with audit and outbox records", async () => {
  const calls = [];
  const service = createProcurementService({ transaction, dao: {
    async findPurchaseOrder() { return { id: orderId, number: "PO-001", status: calls.includes("transition") ? "APPROVED" : "DRAFT" }; },
    async transitionPurchaseOrder() { calls.push("transition"); },
    async insertAudit() { calls.push("audit"); }, async insertOutbox() { calls.push("outbox"); }
  } });
  const result = await service.approvePurchaseOrder(tenantId, orderId, context);
  assert.equal(result.status, "APPROVED"); assert.deepEqual(calls, ["transition", "audit", "outbox"]);
});
