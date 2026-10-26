import assert from "node:assert/strict";
import test from "node:test";
import { createReportsService } from "../src/modules/reports/reports.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
test("reports service applies explicit date filters and combines options", async () => {
  let received;
  const service = createReportsService({ dao: {
    async getReport(input) { received = input; return { rows: [], summary: { orderCount: 0 }, trend: [], total: 0, page: 1, pageSize: 10, totalPages: 1 }; },
    async getOptions() { return { warehouses: [{ id: "warehouse" }], merchants: [] }; }
  } });
  const result = await service.getReport(tenantId, { reportType: "SALES", fromDate: "2026-10-01", toDate: "2026-10-22",
    warehouseId: null, merchantId: null, page: 1, pageSize: 10 });
  assert.equal(received.tenantId, tenantId); assert.equal(received.filters.fromDate, "2026-10-01");
  assert.equal(result.options.warehouses.length, 1); assert.equal(result.reportType, "SALES");
});
test("reports service rejects inverted periods", async () => {
  const service = createReportsService({ dao: {} });
  await assert.rejects(() => service.getReport(tenantId, { reportType: "SALES", fromDate: "2026-10-22",
    toDate: "2026-10-01", warehouseId: null, merchantId: null, page: 1, pageSize: 10 }),
  (error) => error.code === "INVALID_REPORT_RANGE" && error.status === 422);
});
test("reports service creates escaped UTF-8 CSV output", async () => {
  const service = createReportsService({ dao: { async getReport() { return { rows: [{ orderNumber: "ORD-1",
    storeName: 'Main "Flagship"', grandTotal: 1499 }], summary: {}, trend: [], total: 1, page: 1, pageSize: 5000, totalPages: 1 }; } } });
  const result = await service.exportReport(tenantId, { reportType: "SALES", fromDate: "2026-10-01",
    toDate: "2026-10-22", warehouseId: null, merchantId: null });
  assert.match(result.filename, /^sales-/); assert.ok(result.csv.startsWith("\uFEFF")); assert.match(result.csv, /Main ""Flagship""/);
});
