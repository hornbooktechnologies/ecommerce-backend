import assert from "node:assert/strict";
import test from "node:test";
import { transferStockSchema, validateBody } from "../src/modules/inventory/inventory.validators.js";
import { createInventoryService } from "../src/modules/inventory/inventory.service.js";

const sourceBalanceId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const destinationWarehouseId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const serialId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b44";
const body = { sourceBalanceId, destinationWarehouseId, quantity: 3, notes: "Replenish warehouse" };

test("non-serialized transfers accept explicit empty serialIds from the admin form", () => {
  const req = { body: { ...body, sourceLotId: serialId, serialIds: [] } };
  let nextCalls = 0;
  validateBody(transferStockSchema)(req, {}, (error) => { assert.ifError(error); nextCalls++; });
  assert.equal(nextCalls, 1);
  assert.deepEqual(req.validated.body.serialIds, []);
  assert.equal(req.validated.body.sourceLotId, serialId);
  assert.equal(req.validated.body.quantity, 3);
});

test("omitted serialIds normalize to an empty list", () => {
  const result = transferStockSchema.validate(body);
  assert.ifError(result.error);
  assert.deepEqual(result.value.serialIds, []);
});

test("valid serial selections remain accepted", () => {
  const result = transferStockSchema.validate({ ...body, quantity: 1, serialIds: [serialId] });
  assert.ifError(result.error);
  assert.deepEqual(result.value.serialIds, [serialId]);
});

test("invalid, duplicate, sparse and oversized serial selections remain rejected", () => {
  for (const serialIds of [null, "", [""], [null], ["not-a-uuid"], [serialId, serialId], new Array(1),
    Array.from({ length: 501 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`)]) {
    assert.ok(transferStockSchema.validate({ ...body, serialIds }).error);
  }
});

test("serialized products still require a serial selection after schema validation", async () => {
  const { value, error } = transferStockSchema.validate({ ...body, serialIds: [] });
  assert.ifError(error);
  const service = createInventoryService({
    transaction: (_tenantId, operation) => operation({}),
    dao: {
      async findBalanceContext() { return { id: sourceBalanceId, warehouseId: "source",
        merchantId: "merchant", serialTrackingEnabled: true }; },
      async findWarehouse() { return { id: destinationWarehouseId, merchantId: "merchant" }; }
    }
  });
  await assert.rejects(() => service.transferStock("tenant", value, {}),
    (failure) => failure.code === "SERIAL_SELECTION_REQUIRED" && failure.status === 422);
});

test("non-serialized products still reject supplied serial selections", async () => {
  const { value, error } = transferStockSchema.validate({ ...body, quantity: 1, serialIds: [serialId] });
  assert.ifError(error);
  const service = createInventoryService({
    transaction: (_tenantId, operation) => operation({}),
    dao: {
      async findBalanceContext() { return { id: sourceBalanceId, warehouseId: "source",
        merchantId: "merchant", serialTrackingEnabled: false }; },
      async findWarehouse() { return { id: destinationWarehouseId, merchantId: "merchant" }; }
    }
  });
  await assert.rejects(() => service.transferStock("tenant", value, {}),
    (failure) => failure.code === "SERIALS_NOT_SUPPORTED" && failure.status === 422);
});
