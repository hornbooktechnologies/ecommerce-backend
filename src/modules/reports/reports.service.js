import { AppError } from "../../core/errors/app-error.js";
import * as defaultDao from "./reports.dao.js";

const pad = (value) => String(value).padStart(2, "0");
const dateString = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const addDays = (date, amount) => { const next = new Date(date); next.setUTCDate(next.getUTCDate() + amount); return next; };

function normalizeFilters(input, exportMode = false) {
  const today = new Date(); const expiry = input.reportType === "EXPIRY";
  const fromDate = input.fromDate ? new Date(input.fromDate) : expiry ? today : addDays(today, -29);
  const toDate = input.toDate ? new Date(input.toDate) : expiry ? addDays(today, 30) : today;
  if (fromDate > toDate) throw new AppError({ code: "INVALID_REPORT_RANGE",
    message: "The report start date must be on or before the end date.", status: 422 });
  if ((toDate - fromDate) / 86400000 > 366) throw new AppError({ code: "REPORT_RANGE_TOO_LARGE",
    message: "Choose a report period of 366 days or less.", status: 422 });
  return { ...input, fromDate: dateString(fromDate), toDate: dateString(toDate), today: dateString(today),
    warehouseId: input.warehouseId || null, merchantId: input.merchantId || null,
    page: exportMode ? 1 : input.page, pageSize: exportMode ? 5000 : input.pageSize };
}

const csvDefinitions = {
  SALES: [["Order", "orderNumber"], ["Date", "orderDate"], ["Store", "storeName"], ["Status", "status"],
    ["Payment", "paymentStatus"], ["Fulfilment", "fulfillmentStatus"], ["Units", "units"], ["Subtotal INR", "subtotal"],
    ["Discount INR", "discountTotal"], ["Tax INR", "taxTotal"], ["Total INR", "grandTotal"], ["Refunded INR", "refundedTotal"]],
  INVENTORY: [["Product", "productName"], ["Variant", "variantName"], ["SKU", "sku"], ["Seller SKU", "sellerSku"],
    ["Warehouse", "warehouseName"], ["Merchant", "merchantName"], ["On hand", "onHand"], ["Available", "available"],
    ["Reserved", "reserved"], ["Quarantine", "quarantine"], ["Reorder point", "reorderPoint"], ["Health", "health"]],
  EXPIRY: [["Product", "productName"], ["Variant", "variantName"], ["SKU", "sku"], ["Lot", "lotNumber"],
    ["Supplier lot", "supplierLotNumber"], ["Warehouse", "warehouseName"], ["Expiry", "expiresAt"],
    ["Days remaining", "daysRemaining"], ["On hand", "onHand"], ["Reserved", "reserved"], ["Health", "health"]],
  VENDOR: [["Merchant code", "merchantCode"], ["Vendor", "merchantName"], ["Status", "status"], ["Orders", "orderCount"],
    ["Completed", "completedOrders"], ["Gross sales INR", "grossSales"], ["Commission INR", "commission"],
    ["TCS INR", "tcs"], ["TDS INR", "tds"], ["Payable INR", "payable"], ["Last order", "lastOrderAt"]],
  GST_TCS: [["Vendor", "merchantName"], ["Merchant code", "merchantCode"], ["Seller order", "sellerOrderNumber"],
    ["Section", "taxSection"], ["Taxable base INR", "taxableBase"], ["Rate %", "rate"], ["TCS INR", "amount"],
    ["Financial year", "financialYear"], ["Month", "periodMonth"], ["Status", "status"], ["Reference", "governmentReference"]],
  GST_TDS: [["Vendor", "merchantName"], ["Merchant code", "merchantCode"], ["Seller order", "sellerOrderNumber"],
    ["Section", "taxSection"], ["Taxable base INR", "taxableBase"], ["Rate %", "rate"], ["TDS INR", "amount"],
    ["Financial year", "financialYear"], ["Month", "periodMonth"], ["Status", "status"], ["Reference", "governmentReference"]]
};
const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

export function createReportsService({ dao = defaultDao } = {}) {
  async function getReport(tenantId, input) {
    const filters = normalizeFilters(input); const [report, options] = await Promise.all([
      dao.getReport({ tenantId, filters }), dao.getOptions({ tenantId })
    ]);
    return { reportType: filters.reportType, fromDate: filters.fromDate, toDate: filters.toDate,
      generatedAt: new Date().toISOString(), options, ...report };
  }
  async function exportReport(tenantId, input) {
    const filters = normalizeFilters(input, true); const report = await dao.getReport({ tenantId, filters });
    const columns = csvDefinitions[filters.reportType];
    const lines = [columns.map(([label]) => csvCell(label)).join(","),
      ...report.rows.map((row) => columns.map(([, key]) => csvCell(row[key])).join(","))];
    return { csv: `\uFEFF${lines.join("\r\n")}`, filename: `${filters.reportType.toLowerCase()}-${filters.fromDate}-to-${filters.toDate}.csv` };
  }
  return { getReport, exportReport };
}
const service = createReportsService();
export const { getReport, exportReport } = service;
