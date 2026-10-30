import assert from "node:assert/strict";
import test from "node:test";
import PDFDocument from "pdfkit";
import { renderTaxDocumentPdf } from "../src/modules/taxes/tax-document.pdf.js";

function fixture(name, count = 1, documentType = "TAX_INVOICE") {
  return {
    documentType, documentNumber: "TEST/0001", documentDate: "2026-10-28",
    financialYear: "2026-27", placeOfSupplyStateCode: "29",
    tenant: { name: "Verification Retail" }, seller: { legalName: "Verification Retail Ltd",
      tradeName: name, gstin: "29AAAAA0000A1Z5", address: {} },
    buyer: { name: "Verification Customer", shippingAddress: {} },
    orderNumber: "ORDER-TEST", sellerOrderNumber: "SELLER-TEST",
    store: { name: "Main Store", code: "MAIN" }, issuedByName: "Verification",
    taxableTotal: 100 * count, cgstTotal: 9 * count, sgstTotal: 9 * count,
    igstTotal: 0, cessTotal: 0, grandTotal: 118 * count,
    items: Array.from({ length: count }, (_, i) => ({
      lineNumber: i + 1, description: `Test item ${i + 1}`, hsnSacCode: "7323", quantity: 1,
      uomCode: "EA", unitPrice: 118, taxableAmount: 100, cgstRate: 9, sgstRate: 9,
      igstRate: 0, cessRate: 0, cgstAmount: 9, sgstAmount: 9, igstAmount: 0,
      cessAmount: 0, lineTotal: 118
    }))
  };
}

for (const [label, name, count, type] of [
  ["short", "Hornbook Retail", 1, "TAX_INVOICE"],
  ["wrapped", "Hornbook Retail - Demo Tax Identity", 1, "TAX_INVOICE"],
  ["maximum length", "Worldwide Retail and Distribution ".repeat(6).slice(0, 190), 1, "TAX_INVOICE"],
  ["unbroken", "W".repeat(190), 1, "TAX_INVOICE"],
  ["multiple pages", "Hornbook Retail - Demo Tax Identity", 28, "TAX_INVOICE"],
  ["credit note", "Hornbook Retail - Demo Tax Identity", 1, "CREDIT_NOTE"],
  ["debit note", "Hornbook Retail - Demo Tax Identity", 1, "DEBIT_NOTE"]
]) {
  test(`watermark caption clears the ${label} company name`, async (t) => {
    const originalText = PDFDocument.prototype.text;
    let nameBottom, nameTop, names = 0, captions = 0;
    t.mock.method(PDFDocument.prototype, "text", function (text, x, y, options) {
      const isName = options?.width === 460;
      if (options?.width === 440) {
        assert.ok(Number.isFinite(nameBottom));
        assert.ok(y >= nameBottom + 12, "Caption must clear the last company-name line");
        assert.ok(nameBottom - nameTop <= 85, "Company watermark must remain compact");
        captions++;
      }
      const result = originalText.call(this, text, x, y, options);
      if (isName) {
        assert.equal(text, name.toUpperCase(), "Do not truncate the company name");
        nameTop = y; nameBottom = this.y; names++;
      }
      return result;
    });
    const buffer = await renderTaxDocumentPdf(fixture(name, count, type));
    assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
    assert.equal(names, captions);
    assert.ok(captions >= (count > 1 ? 2 : 1));
  });
}
