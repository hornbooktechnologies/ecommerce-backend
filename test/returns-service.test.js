import assert from "node:assert/strict";
import test from "node:test";
import { createReturnsService } from "../src/modules/returns/returns.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const itemId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const context = { actorUserId: itemId, requestId: "req", ipAddress: "127.0.0.1", userAgent: "test" };
const transaction = (_tenantId, operation) => operation({});

test("non-clothing items cannot enter the exchange workflow", async () => {
  const dao = {
    async findOrderItemForReturn() { return { id: itemId, isReturnable: true, fulfillmentStatus: "FULFILLED",
      quantity: 1, returnedQuantity: 0, vertical: "ELECTRONICS", serialTracking: false }; }
  };
  const service = createReturnsService({ dao, transaction });
  await assert.rejects(() => service.createReturn(tenantId, { orderItemId: itemId, returnType: "EXCHANGE",
    quantity: 1, serialIds: [], reasonCode: "OTHER", customerComments: "" }, context),
  (error) => error.code === "EXCHANGE_REQUIRES_CLOTHING");
});

test("serialized returns require one eligible serial per unit", async () => {
  const dao = {
    async findOrderItemForReturn() { return { id: itemId, isReturnable: true, fulfillmentStatus: "FULFILLED",
      quantity: 2, returnedQuantity: 0, vertical: "ELECTRONICS", serialTracking: true }; }
  };
  const service = createReturnsService({ dao, transaction });
  await assert.rejects(() => service.createReturn(tenantId, { orderItemId: itemId, returnType: "RETURN",
    quantity: 2, serialIds: [itemId], reasonCode: "DEFECTIVE", customerComments: "" }, context),
  (error) => error.code === "RETURN_SERIALS_REQUIRED");
});

test("bundle inspection restores component offers instead of synthetic bundle stock", async () => {
  const restored = [];
  const dao = {
    async getReturn() { return { request: { status: "RECEIVED", warehouseId: "warehouse",
      returnNumber: "RET-1", reasonCode: "DEFECTIVE" }, items: [] }; },
    async listReturnItemsForDisposition() { return [{ id: "return-item", orderItemId: itemId,
      quantity: 1, orderedQuantity: 1, lineTotal: 500, isBundle: true }]; },
    async inspectReturnItem() {},
    async listBundleReturnStock() { return [{ offerId: "component-offer", productName: "Cable",
      quantity: 2, lotTracking: false, serialId: null }]; },
    async findOrCreateBalance({ offerId }) { restored.push(["balance", offerId]); return "balance"; },
    async addReturnedStock({ quantity }) { restored.push(["stock", quantity]); },
    async insertStockLedger({ entry }) { restored.push(["ledger", entry.quantity]); },
    async voidReturnedWarranties() { return 0; },
    async updateReturnStatus() {}, async insertAudit() {}
  };
  const service = createReturnsService({ dao, transaction });
  await service.inspectReturn(tenantId, "return", { itemCondition: "GOOD",
    disposition: "RESTOCK", notes: "Complete bundle received" }, context);
  assert.deepEqual(restored, [["balance", "component-offer"], ["stock", 2], ["ledger", 2]]);
});

for (const disposition of ["RESTOCK", "QUARANTINE", "SCRAP"]) {
  test(`inspection voids sale warranties atomically for ${disposition}`, async () => {
    const calls = [];
    const connection = {};
    const dao = {
      async getReturn() { return { request: { status: "RECEIVED", warehouseId: "warehouse",
        returnNumber: "RET-1", reasonCode: "DEFECTIVE" }, items: [] }; },
      async listReturnItemsForDisposition() { return [{ id: "item", quantity: 1,
        orderedQuantity: 1, lineTotal: 100, offerId: "offer", serialId: "serial" }]; },
      async inspectReturnItem() { calls.push("inspect"); },
      async listBundleReturnStock() { return [{ offerId: "component", quantity: 1,
        serialId: "bundle-serial" }]; },
      async findOrCreateBalance() { return "balance"; },
      async addReturnedStock() {}, async insertStockLedger() {},
      async updateReturnedSerial({ serialId }) { calls.push(serialId); },
      async markSerialDisposition({ serialId }) { calls.push(serialId); },
      async voidReturnedWarranties(args) {
        assert.deepEqual(args, { tenantId, returnId: "return", connection });
        calls.push("void"); return 2;
      },
      async updateReturnStatus({ connection: received }) { assert.equal(received, connection); calls.push("status"); },
      async insertAudit({ audit }) { assert.equal(audit.afterData.voidedWarrantyCount, 2); calls.push("audit"); }
    };
    const service = createReturnsService({ dao, transaction: (_, operation) => operation(connection) });
    await service.inspectReturn(tenantId, "return", { itemCondition: "DEFECTIVE", disposition }, context);
    assert.deepEqual(calls, ["inspect", "serial", "bundle-serial", "void", "status", "audit"]);
  });
}

test("warranty update failure aborts inspection instead of marking it successful", async () => {
  const dao = {
    async getReturn() { return { request: { status: "RECEIVED", warehouseId: "warehouse" } }; },
    async listReturnItemsForDisposition() { return []; },
    async listBundleReturnStock() { return []; },
    async voidReturnedWarranties() { throw new Error("warranty write failed"); },
    async updateReturnStatus() { assert.fail("must not complete inspection"); },
    async insertAudit() { assert.fail("must not record successful inspection"); }
  };
  const service = createReturnsService({ dao, transaction });
  await assert.rejects(service.inspectReturn(tenantId, "return", { disposition: "RESTOCK" }, context),
    /warranty write failed/);
});
