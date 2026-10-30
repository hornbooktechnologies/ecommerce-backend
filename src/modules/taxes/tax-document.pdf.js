import PDFDocument from "pdfkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";

const palette = {
  ink: "#171713", muted: "#68675f", line: "#d8d3c7", soft: "#f4f1e9",
  gold: "#9a7942", green: "#176448", white: "#ffffff"
};

const money = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quantity = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });

function amount(value) { return `INR ${money.format(Number(value || 0))}`; }
function clean(value) { return String(value || "-").replace(/[\u2010-\u2015]/g, "-"); }
function addressLines(address = {}) {
  return [address.line1, address.line2, [address.city, address.stateName].filter(Boolean).join(", "),
    [address.postalCode, address.countryCode === "IN" ? "India" : address.countryCode].filter(Boolean).join(" - ")]
    .filter(Boolean).map(clean);
}
function documentLabel(type) {
  return { TAX_INVOICE: "TAX INVOICE", CREDIT_NOTE: "CREDIT NOTE", DEBIT_NOTE: "DEBIT NOTE" }[type] || clean(type);
}

function companyName(detail) {
  return clean(detail.seller.tradeName || detail.seller.legalName || detail.merchantName);
}

function companyInitials(detail) {
  return companyName(detail).split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0]?.toUpperCase()).join("") || "CO";
}

async function loadVendorLogo(logoUrl) {
  if (!logoUrl) return null;
  try {
    const url = new URL(logoUrl);
    if (url.origin !== new URL(env.apiPublicUrl).origin
      || !url.pathname.startsWith("/media/vendor-logos/")) return null;
    const fileName = decodeURIComponent(url.pathname.slice("/media/vendor-logos/".length));
    if (!fileName || fileName !== path.basename(fileName)) return null;
    return await readFile(path.join(path.resolve(env.vendorLogoDirectory), fileName));
  } catch {
    return null;
  }
}

function addWatermark(doc, detail) {
  const centerX = doc.page.width / 2;
  const centerY = doc.page.height / 2 + 18;

  doc.save();
  doc.rotate(-24, { origin: [centerX, centerY] });
  if (doc.vendorLogo) {
    try {
      doc.opacity(0.075).image(doc.vendorLogo, centerX - 78, centerY - 112, {
        fit: [156, 104], align: "center", valign: "center"
      });
    } catch {
      doc.opacity(0.06).lineWidth(2.5).strokeColor(palette.gold)
        .roundedRect(centerX - 52, centerY - 100, 104, 86, 18).stroke();
      doc.fillColor(palette.gold).font("Helvetica-Bold").fontSize(34)
        .text(companyInitials(detail), centerX - 52, centerY - 72, { width: 104, align: "center" });
    }
  } else {
    doc.opacity(0.06).lineWidth(2.5).strokeColor(palette.gold)
      .roundedRect(centerX - 52, centerY - 100, 104, 86, 18).stroke();
    doc.fillColor(palette.gold).font("Helvetica-Bold").fontSize(34)
      .text(companyInitials(detail), centerX - 52, centerY - 72, { width: 104, align: "center" });
  }

  const name = companyName(detail).toUpperCase();
  const nameOptions = {
    width: 460, align: "center", characterSpacing: name.length > 32 ? 1.1 : 2.2
  };
  let nameSize = name.length > 32 ? 27 : 34;
  doc.opacity(0.058).fillColor(palette.gold).font("Helvetica-Bold").fontSize(nameSize);
  // Keep long names compact without truncation; measure with the rendering options.
  while (nameSize > 10 && doc.heightOfString(name, nameOptions) > 84) {
    doc.fontSize(--nameSize);
  }
  doc.text(name, centerX - 230, centerY + 22, nameOptions);
  // PDFKit advances y past all wrapped lines. A fixed offset overlaps long names.
  const captionY = doc.y + 12;
  doc.font("Helvetica").fontSize(9)
    .text(documentLabel(detail.documentType), centerX - 220, captionY, {
      width: 440, align: "center", characterSpacing: 2.1
    });
  doc.restore();
}

function addPageBase(doc, detail) {
  addWatermark(doc, detail);
  doc.rect(0, 0, doc.page.width, 10).fill(palette.gold);
  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(16)
    .text(clean(detail.tenant.name), 38, 30, { width: 330 });
  doc.fillColor(palette.muted).font("Helvetica").fontSize(8.5)
    .text("COMMERCE OPERATIONS", 38, 51, { characterSpacing: 1.2 });
  doc.roundedRect(420, 28, 137, 31, 6).fill(palette.ink);
  doc.fillColor(palette.white).font("Helvetica-Bold").fontSize(10)
    .text(documentLabel(detail.documentType), 420, 39, { width: 137, align: "center" });
  doc.moveTo(38, 75).lineTo(557, 75).strokeColor(palette.line).lineWidth(0.8).stroke();
}

function labelValue(doc, label, value, x, y, width, align = "left") {
  doc.fillColor(palette.muted).font("Helvetica").fontSize(7.5)
    .text(clean(label).toUpperCase(), x, y, { width, align, characterSpacing: 0.7 });
  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(9.5)
    .text(clean(value), x, y + 12, { width, align });
}

function box(doc, title, lines, x, y, width, height) {
  doc.roundedRect(x, y, width, height, 7).fillAndStroke(palette.soft, palette.line);
  doc.fillColor(palette.gold).font("Helvetica-Bold").fontSize(7.5)
    .text(title.toUpperCase(), x + 13, y + 12, { characterSpacing: 0.8 });
  let cursor = y + 29;
  lines.forEach((line, index) => {
    doc.fillColor(index === 0 ? palette.ink : palette.muted)
      .font(index === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(index === 0 ? 9.5 : 8.2)
      .text(clean(line), x + 13, cursor, { width: width - 26, lineGap: 2 });
    cursor = doc.y + 2;
  });
}

function tableHeader(doc, y) {
  doc.rect(38, y, 519, 25).fill(palette.ink);
  const columns = [
    ["Description", 46, 160, "left"], ["HSN", 212, 42, "left"], ["Qty", 258, 40, "right"],
    ["Rate", 302, 64, "right"], ["Taxable", 370, 68, "right"], ["GST", 442, 38, "right"],
    ["Total", 484, 65, "right"]
  ];
  doc.fillColor(palette.white).font("Helvetica-Bold").fontSize(7.3);
  columns.forEach(([text, x, width, align]) => doc.text(text, x, y + 9, { width, align }));
  return y + 25;
}

function addTableRow(doc, item, y) {
  const descriptionHeight = doc.heightOfString(clean(item.description), { width: 156, lineGap: 1 });
  const height = Math.max(34, descriptionHeight + 16);
  if (y + height > 720) {
    doc.addPage();
    addPageBase(doc, doc.invoiceDetail);
    y = tableHeader(doc, 92);
  }
  if (item.lineNumber % 2 === 0) doc.rect(38, y, 519, height).fill("#faf9f6");
  doc.fillColor(palette.ink).font("Helvetica").fontSize(7.8);
  doc.text(clean(item.description), 46, y + 9, { width: 156, lineGap: 1 });
  doc.text(clean(item.hsnSacCode), 212, y + 9, { width: 42 });
  doc.text(`${quantity.format(item.quantity)} ${clean(item.uomCode)}`, 258, y + 9, { width: 40, align: "right" });
  doc.text(amount(item.unitPrice), 302, y + 9, { width: 64, align: "right" });
  doc.text(amount(item.taxableAmount), 370, y + 9, { width: 68, align: "right" });
  const taxRate = item.igstRate || item.cgstRate + item.sgstRate + item.cessRate;
  doc.text(`${quantity.format(taxRate)}%`, 442, y + 9, { width: 38, align: "right" });
  doc.font("Helvetica-Bold").text(amount(item.lineTotal), 484, y + 9, { width: 65, align: "right" });
  doc.moveTo(38, y + height).lineTo(557, y + height).strokeColor(palette.line).lineWidth(0.5).stroke();
  return y + height;
}

function taxSummary(detail) {
  const groups = new Map();
  for (const item of detail.items) {
    const rate = item.igstRate || item.cgstRate + item.sgstRate + item.cessRate;
    const key = `${item.hsnSacCode}|${rate}`;
    const current = groups.get(key) || { hsnSacCode: item.hsnSacCode || "-", rate,
      taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
    current.taxable += item.taxableAmount; current.cgst += item.cgstAmount;
    current.sgst += item.sgstAmount; current.igst += item.igstAmount; current.cess += item.cessAmount;
    groups.set(key, current);
  }
  return [...groups.values()];
}

function addTotals(doc, detail, y) {
  if (y > 585) { doc.addPage(); addPageBase(doc, detail); y = 92; }
  const rows = [
    ["Taxable value", detail.taxableTotal], ["CGST", detail.cgstTotal], ["SGST", detail.sgstTotal],
    ["IGST", detail.igstTotal], ["Cess", detail.cessTotal]
  ].filter(([, value], index) => index === 0 || Number(value) !== 0);
  const summary = taxSummary(detail);
  const boxHeight = Math.max(86, 35 + summary.length * 18);
  doc.roundedRect(38, y + 16, 321, boxHeight, 7).strokeColor(palette.line).stroke();
  doc.fillColor(palette.gold).font("Helvetica-Bold").fontSize(7.5)
    .text("HSN-WISE TAX SUMMARY", 51, y + 29, { characterSpacing: 0.7 });
  let sy = y + 49;
  doc.fillColor(palette.muted).font("Helvetica-Bold").fontSize(7);
  doc.text("HSN / RATE", 51, sy, { width: 82 });
  doc.text("TAXABLE", 140, sy, { width: 74, align: "right" });
  doc.text("GST", 222, sy, { width: 58, align: "right" });
  doc.text("CESS", 288, sy, { width: 58, align: "right" });
  sy += 14;
  summary.forEach((row) => {
    doc.fillColor(palette.ink).font("Helvetica").fontSize(7.2);
    doc.text(`${clean(row.hsnSacCode)} / ${quantity.format(row.rate)}%`, 51, sy, { width: 82 });
    doc.text(amount(row.taxable), 140, sy, { width: 74, align: "right" });
    doc.text(amount(row.cgst + row.sgst + row.igst), 222, sy, { width: 58, align: "right" });
    doc.text(amount(row.cess), 288, sy, { width: 58, align: "right" });
    sy += 18;
  });

  doc.roundedRect(373, y + 16, 184, boxHeight, 7).fillAndStroke(palette.soft, palette.line);
  let ty = y + 29;
  rows.forEach(([label, value]) => {
    doc.fillColor(palette.muted).font("Helvetica").fontSize(8).text(label, 388, ty, { width: 72 });
    doc.fillColor(palette.ink).font("Helvetica-Bold").text(amount(value), 462, ty, { width: 80, align: "right" });
    ty += 16;
  });
  doc.moveTo(388, ty + 2).lineTo(542, ty + 2).strokeColor(palette.gold).lineWidth(1).stroke();
  doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(10).text("Invoice total", 388, ty + 12, { width: 72 });
  doc.fillColor(palette.green).font("Helvetica-Bold").fontSize(11)
    .text(amount(detail.grandTotal), 462, ty + 11, { width: 80, align: "right" });
  return y + 16 + boxHeight;
}

function addFooters(doc) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    doc.moveTo(38, 760).lineTo(557, 760).strokeColor(palette.line).lineWidth(0.5).stroke();
    doc.fillColor(palette.muted).font("Helvetica").fontSize(7)
      .text("Computer-generated tax document. No signature is required.", 38, 770, { width: 400 });
    doc.text(`Page ${index + 1} of ${range.count}`, 470, 770, { width: 87, align: "right" });
  }
}

export async function renderTaxDocumentPdf(detail) {
  const watermarkLogo = await loadVendorLogo(detail.seller.logoUrl);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: "A4", margins: { top: 28, right: 38, bottom: 60, left: 38 },
      bufferPages: true, info: { Title: `${documentLabel(detail.documentType)} ${detail.documentNumber}`,
        Author: detail.seller.legalName, Subject: `GST document for ${detail.orderNumber}` } });
    doc.invoiceDetail = detail;
    doc.vendorLogo = watermarkLogo;
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    addPageBase(doc, detail);
    labelValue(doc, "Invoice number", detail.documentNumber, 38, 91, 180);
    labelValue(doc, "Document date", detail.documentDate, 235, 91, 115);
    labelValue(doc, "Financial year", detail.financialYear, 367, 91, 90);
    labelValue(doc, "Place of supply", detail.placeOfSupplyStateCode, 474, 91, 83, "right");
    const sellerLines = [detail.seller.legalName, `GSTIN: ${detail.seller.gstin}`,
      ...addressLines(detail.seller.address)];
    const buyerAddress = Object.keys(detail.buyer.billingAddress || {}).length
      ? detail.buyer.billingAddress
      : detail.buyer.shippingAddress || {};
    const buyerLines = [detail.buyer.name || "Customer",
      detail.buyer.gstin ? `GSTIN: ${detail.buyer.gstin}` : "GSTIN: Unregistered",
      ...addressLines(buyerAddress), detail.buyer.email, detail.buyer.phone].filter(Boolean);
    box(doc, "Supplier", sellerLines, 38, 131, 251, 142);
    box(doc, "Bill to", buyerLines, 306, 131, 251, 142);
    labelValue(doc, "Order reference", detail.orderNumber, 38, 289, 175);
    labelValue(doc, "Seller order", detail.sellerOrderNumber || "-", 223, 289, 175);
    labelValue(doc, "Store", `${detail.store.name} (${detail.store.code})`, 408, 289, 149, "right");
    let y = tableHeader(doc, 327);
    detail.items.forEach((item) => { y = addTableRow(doc, item, y); });
    y = addTotals(doc, detail, y + 3);
    if (y > 700) { doc.addPage(); addPageBase(doc, detail); y = 92; }
    doc.fillColor(palette.muted).font("Helvetica").fontSize(7.5)
      .text(`Reverse charge: ${detail.reverseCharge ? "Yes" : "No"}  |  Issued by: ${clean(detail.issuedByName)}`,
        38, y + 18, { width: 519 });
    doc.fillColor(palette.ink).font("Helvetica-Bold").fontSize(8)
      .text("Declaration", 38, y + 38, { width: 90 });
    doc.fillColor(palette.muted).font("Helvetica").fontSize(7.5)
      .text("We declare that this document reflects the transaction recorded in Commerce OS and that the particulars shown are true to the issued record.",
        38, y + 52, { width: 519, lineGap: 2 });
    addFooters(doc);
    doc.end();
  });
}
