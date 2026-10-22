import assert from "node:assert/strict";
import test from "node:test";
import { createInventoryService } from "../src/modules/inventory/inventory.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const balanceId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const context = { actorUserId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77",
  requestId: "request-1", ipAddress: "127.0.0.1", userAgent: "test" };
const transaction = (_tenantId, operation) => operation({});

test("grocery receipts require a batch number", async () => {
  const service = createInventoryService({ transaction, dao: {
    async findWarehouse() { return { id: "warehouse", merchantId: "merchant" }; },
    async findOfferContext() { return { id: "offer", merchantId: "merchant",
      lotTrackingEnabled: true, expiryTrackingEnabled: true, serialTrackingEnabled: false }; }
  } });
  await assert.rejects(() => service.receiveStock(tenantId, {
    warehouseId: "warehouse", offerId: "offer", quantity: 2, lotNumber: "",
    expiresAt: null, manufacturedAt: null, serialNumbers: []
  }, context), (error) => error.code === "LOT_NUMBER_REQUIRED" && error.status === 422);
});

test("serialized receipts require one serial per unit", async () => {
  const service = createInventoryService({ transaction, dao: {
    async findWarehouse() { return { id: "warehouse", merchantId: "merchant" }; },
    async findOfferContext() { return { id: "offer", merchantId: "merchant",
      lotTrackingEnabled: false, expiryTrackingEnabled: false, serialTrackingEnabled: true }; }
  } });
  await assert.rejects(() => service.receiveStock(tenantId, {
    warehouseId: "warehouse", offerId: "offer", quantity: 2, lotNumber: "",
    expiresAt: null, manufacturedAt: null, serialNumbers: ["SN-01"]
  }, context), (error) => error.code === "SERIAL_COUNT_MISMATCH" && error.status === 422);
});

test("counted stock cannot drop below reserved and quarantined quantities", async () => {
  const service = createInventoryService({ transaction, dao: {
    async findBalanceContext() { return { id: balanceId, warehouseId: "warehouse",
      onHandQuantity: 10, reservedQuantity: 3, quarantineQuantity: 2,
      lotTrackingEnabled: false, serialTrackingEnabled: false }; }
  } });
  await assert.rejects(() => service.adjustStock(tenantId, {
    balanceId, lotId: null, countedQuantity: 4, reasonCode: "CYCLE_COUNT", notes: "Counted on shelf"
  }, context), (error) => error.code === "COUNT_BELOW_COMMITTED_STOCK" && error.status === 409);
});

test("serialized stock blocks unsafe quantity-only adjustments", async () => {
  const service = createInventoryService({ transaction, dao: {
    async findBalanceContext() { return { id: balanceId, warehouseId: "warehouse",
      onHandQuantity: 2, reservedQuantity: 0, quarantineQuantity: 0,
      lotTrackingEnabled: false, serialTrackingEnabled: true }; }
  } });
  await assert.rejects(() => service.adjustStock(tenantId, {
    balanceId, lotId: null, countedQuantity: 1, reasonCode: "CYCLE_COUNT", notes: "Counted on shelf"
  }, context), (error) => error.code === "SERIAL_RECONCILIATION_REQUIRED" && error.status === 422);
});

test("warehouse transfer rejects quantities above available stock", async () => {
  const service = createInventoryService({ transaction, dao: {
    async findBalanceContext() { return { id: balanceId, warehouseId: "source", offerId: "offer",
      merchantId: "merchant", onHandQuantity: 8, reservedQuantity: 3, quarantineQuantity: 1,
      lotTrackingEnabled: false, serialTrackingEnabled: false }; },
    async findWarehouse() { return { id: "destination", merchantId: "merchant" }; }
  } });
  await assert.rejects(() => service.transferStock(tenantId, {
    sourceBalanceId: balanceId, destinationWarehouseId: "destination", sourceLotId: null,
    quantity: 5, notes: "Replenish destination"
  }, context), (error) => error.code === "INSUFFICIENT_AVAILABLE_STOCK" && error.status === 409);
});

test("serialized transfer moves exact available serials and writes unit ledgers", async () => {
  const calls = [];
  const serialId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b44";
  const destinationBalanceId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b33";
  const service = createInventoryService({ transaction, dao: {
    async findBalanceContext() { return { id: balanceId, warehouseId: "source", offerId: "offer",
      merchantId: "merchant", onHandQuantity: 2, reservedQuantity: 0, quarantineQuantity: 0,
      lotTrackingEnabled: false, serialTrackingEnabled: true }; },
    async findWarehouse() { return { id: "destination", merchantId: "merchant" }; },
    async findTransferSerials() { return [{ id: serialId, serialNumber: "SN-01",
      status: "AVAILABLE", lotId: null, unitCost: 100 }]; },
    async findBalance() { return { id: destinationBalanceId }; },
    async insertTransfer() { calls.push("transfer"); },
    async insertTransferItem() { calls.push("item"); },
    async updateBalanceQuantity() { calls.push("balance"); },
    async updateSerialLocation(input) { calls.push(`serial:${input.balanceId}`); },
    async insertLedger(input) { calls.push(`ledger:${input.entry.movementType}:${input.entry.serialId}`); },
    async insertAudit() { calls.push("audit"); },
    async insertOutbox() { calls.push("outbox"); }
  } });
  const result = await service.transferStock(tenantId, {
    sourceBalanceId: balanceId, destinationWarehouseId: "destination", sourceLotId: null,
    quantity: 1, serialIds: [serialId], notes: "Move demo unit"
  }, context);
  assert.equal(result.transfer.serialCount, 1);
  assert.equal(result.destinationBalanceId, destinationBalanceId);
  assert.deepEqual(calls, ["transfer", "item", "balance", "balance",
    `serial:${destinationBalanceId}`, `ledger:TRANSFER_OUT:${serialId}`,
    `ledger:TRANSFER_IN:${serialId}`, "audit", "outbox"]);
});

test("serialized transfer rejects a quantity that differs from selected serials", async () => {
  const service = createInventoryService({ transaction, dao: {
    async findBalanceContext() { return { id: balanceId, warehouseId: "source", offerId: "offer",
      merchantId: "merchant", onHandQuantity: 2, reservedQuantity: 0, quarantineQuantity: 0,
      lotTrackingEnabled: false, serialTrackingEnabled: true }; },
    async findWarehouse() { return { id: "destination", merchantId: "merchant" }; }
  } });
  await assert.rejects(() => service.transferStock(tenantId, {
    sourceBalanceId: balanceId, destinationWarehouseId: "destination", sourceLotId: null,
    quantity: 2, serialIds: ["018f47f2-6b6d-7c34-ae31-8f4f17b79b44"], notes: "Move unit"
  }, context), (error) => error.code === "SERIAL_TRANSFER_QUANTITY_MISMATCH" && error.status === 422);
});

test("stock policy writes an audited balance threshold", async () => {
  const calls = [];
  const service = createInventoryService({ transaction, dao: {
    async findBalanceContext() { return { id: balanceId }; },
    async updateStockPolicy(input) { calls.push(["policy", input.policy]); },
    async insertAudit() { calls.push(["audit"]); },
    async insertOutbox() { calls.push(["outbox"]); }
  } });
  const result = await service.updateStockPolicy(tenantId, balanceId, {
    safetyStockQuantity: 2, reorderPointQuantity: 5, reorderQuantity: 10
  }, context);
  assert.equal(result.reorderPointQuantity, 5);
  assert.deepEqual(calls.map(([name]) => name), ["policy", "audit", "outbox"]);
});

test("traceability lists return pagination and summary data", async () => {
  const service = createInventoryService({ transaction, dao: {
    async listTraceabilityLots() { return { items: [{ id: "lot" }], total: 21 }; },
    async summarizeTraceabilityLots() { return { total: 21, expiring: 2, expired: 1, quarantined: 1 }; }
  } });
  const result = await service.listTraceabilityLots(tenantId, {
    search: "", health: "ALL", warehouseId: "", page: 2, pageSize: 10
  });
  assert.equal(result.totalPages, 3);
  assert.equal(result.summary.expiring, 2);
});

test("available serials can be quarantined with ledger and audit history", async () => {
  const calls = [];
  const service = createInventoryService({ transaction, dao: {
    async findSerialContext() { return { id: balanceId, balanceId, lotId: null,
      serialNumber: "SN-01", status: "AVAILABLE", warehouseId: "warehouse" }; },
    async updateBalanceTraceability(input) { calls.push(["balance", input.quarantineDelta]); return true; },
    async updateSerialStatus(input) { calls.push(["serial", input.status]); },
    async insertLedger(input) { calls.push(["ledger", input.entry.quarantineDelta]); },
    async insertAudit() { calls.push(["audit"]); },
    async insertOutbox() { calls.push(["outbox"]); }
  } });
  const result = await service.reconcileSerial(tenantId, balanceId, {
    status: "QUARANTINED", reasonCode: "QUALITY_HOLD", notes: "Screen inspection required"
  }, context);
  assert.equal(result.serial.status, "QUARANTINED");
  assert.deepEqual(calls, [["balance", 1], ["serial", "QUARANTINED"],
    ["ledger", 1], ["audit"], ["outbox"]]);
});

test("sold serials remain controlled by the order lifecycle", async () => {
  const service = createInventoryService({ transaction, dao: {
    async findSerialContext() { return { id: balanceId, serialNumber: "SN-01", status: "SOLD" }; }
  } });
  await assert.rejects(() => service.reconcileSerial(tenantId, balanceId, {
    status: "QUARANTINED", reasonCode: "DAMAGE", notes: "Reported damaged"
  }, context), (error) => error.code === "SERIAL_LIFECYCLE_LOCKED" && error.status === 409);
});
