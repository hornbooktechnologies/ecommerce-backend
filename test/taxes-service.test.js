import assert from "node:assert/strict";
import test from "node:test";
import { createTaxesService } from "../src/modules/taxes/taxes.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const sellerOrderId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const seriesId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const context = { actorUserId: userId, requestId: "req", ipAddress: "127.0.0.1", userAgent: "test" };
const transaction = (_tenantId, operation) => operation({});

function sellerOrder(overrides = {}) {
  return { id: sellerOrderId, orderId: seriesId, merchantId: userId, storeId: userId,
    status: "COMPLETED", currency: "INR", shippingTotal: "0", grandTotal: "100",
    hasInvoice: false, billingAddress: { stateCode: "KA" }, ...overrides };
}

function series(overrides = {}) {
  return { id: seriesId, registrationId: userId, storeId: null, documentType: "TAX_INVOICE",
    financialYear: "2026-27", prefix: "INV/", nextNumber: 1, numberPadding: 6,
    version: 0, ...overrides };
}

function item(overrides = {}) {
  return { id: userId, productName: "Taxable product", variantName: "Standard", hsnSacCode: "8517",
    quantity: "1", uomCode: "NOS", unitPrice: "100", discountAmount: "0",
    taxableAmount: "100", cgstRate: "0", cgstAmount: "0", sgstRate: "0",
    sgstAmount: "0", igstRate: "0", igstAmount: "0", cessRate: "0",
    cessAmount: "0", lineTotal: "100", ...overrides };
}

test("tax invoices cannot be issued twice for the same seller order", async () => {
  const dao = { async findSellerOrderForInvoice() { return sellerOrder({ hasInvoice: true }); } };
  const service = createTaxesService({ dao, transaction });
  await assert.rejects(() => service.issueTaxInvoice(tenantId,
    { sellerOrderId, seriesId, documentDate: "2026-10-16" }, context),
  (error) => error.code === "TAX_INVOICE_ALREADY_ISSUED");
});

test("tax invoices require a matching financial-year series", async () => {
  const dao = {
    async findSellerOrderForInvoice() { return sellerOrder(); },
    async findInvoiceSeriesForIssue() { return series({ financialYear: "2025-26" }); }
  };
  const service = createTaxesService({ dao, transaction });
  await assert.rejects(() => service.issueTaxInvoice(tenantId,
    { sellerOrderId, seriesId, documentDate: "2026-10-16" }, context),
  (error) => error.code === "TAX_INVOICE_FINANCIAL_YEAR_MISMATCH");
});

test("issuing a tax invoice allocates one number and snapshots line totals", async () => {
  const calls = [];
  const dao = {
    async findSellerOrderForInvoice() { return sellerOrder(); },
    async findInvoiceSeriesForIssue() { return series(); },
    async listSellerOrderItemsForInvoice() { return [item()]; },
    async incrementInvoiceSeries() { calls.push("increment"); return true; },
    async insertTaxDocument({ document }) { calls.push(["document", document.number,
      document.placeOfSupplyStateCode, document.grandTotal]); },
    async insertTaxDocumentItems({ items }) { calls.push(["items", items.length, items[0].lineTotal]); },
    async insertAudit({ audit }) { calls.push(["audit", audit.action]); },
    async getWorkspace() { return { taxDocuments: [{ documentNumber: "INV/000001" }] }; }
  };
  const service = createTaxesService({ dao, transaction });
  const result = await service.issueTaxInvoice(tenantId,
    { sellerOrderId, seriesId, documentDate: "2026-10-16" }, context);
  assert.equal(result.taxDocuments[0].documentNumber, "INV/000001");
  assert.deepEqual(calls, ["increment", ["document", "INV/000001", "29", "100.0000"],
    ["items", 1, "100"], ["audit", "TAX_INVOICE_ISSUED"]]);
});

test("tax document PDF uses tenant-scoped detail and a safe filename", async () => {
  const document = { id: seriesId, documentType: "TAX_INVOICE",
    documentNumber: "INV/2026-27/000001" };
  const dao = { async getTaxDocumentDetail() { return document; } };
  let rendered;
  const service = createTaxesService({ dao, transaction, pdfRenderer: async (detail) => {
    rendered = detail; return Buffer.from("pdf");
  } });
  const result = await service.getTaxDocumentPdf(tenantId, seriesId);
  assert.equal(rendered, document);
  assert.equal(result.filename, "tax_invoice-INV-2026-27-000001.pdf");
  assert.equal(result.buffer.toString(), "pdf");
});

test("missing tax document detail returns a tenant-safe 404", async () => {
  const dao = { async getTaxDocumentDetail() { return null; } };
  const service = createTaxesService({ dao, transaction });
  await assert.rejects(() => service.getTaxDocument(tenantId, seriesId),
    (error) => error.code === "TAX_DOCUMENT_NOT_FOUND" && error.status === 404);
});
