import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { normalizeGstStateCode } from "../../core/india/gst.js";
import { withTransaction } from "../../database/transaction.js";
import Decimal from "decimal.js";
import * as defaultDao from "./taxes.dao.js";
import { renderTaxDocumentPdf } from "./tax-document.pdf.js";

function fail(code, message, status = 422, field = null) {
  throw new AppError({ code, message, status, details: field ? [{ field, code: code.toLowerCase(), message }] : [] });
}

function audit(context, values) {
  return { id: createId(), actorUserId: context.actorUserId, requestId: context.requestId,
    ipAddress: context.ipAddress || "127.0.0.1", userAgent: context.userAgent, ...values };
}

function financialYearFor(documentDate) {
  const [year, month] = documentDate.split("-").map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function placeOfSupply(address = {}) {
  return normalizeGstStateCode(address.stateCode);
}

export function createTaxesService({ dao = defaultDao, transaction = withTransaction,
  pdfRenderer = renderTaxDocumentPdf } = {}) {
  const getWorkspace = (tenantId) => dao.getWorkspace({ tenantId });

  async function saveRegistration(tenantId, registrationId, input, context) {
    const creating = !registrationId;
    try {
      await transaction(tenantId, async (connection) => {
        if (input.storeId && !await dao.findStore({ tenantId, storeId: input.storeId, connection })) {
          fail("TAX_STORE_NOT_FOUND", "Select a store belonging to this workspace.", 422, "storeId");
        }
        let addressId;
        if (creating) {
          registrationId = createId(); addressId = createId();
          await dao.insertAddress({ address: { id: addressId, tenantId, ...input }, connection });
          await dao.insertRegistration({ registration: { id: registrationId, addressId, tenantId, ...input }, connection });
        } else {
          const current = await dao.findRegistration({ tenantId, registrationId, connection, forUpdate: true });
          if (!current) fail("GST_REGISTRATION_NOT_FOUND", "GST registration was not found.", 404);
          addressId = current.addressId;
          await dao.updateAddress({ addressId, input, connection });
          await dao.updateRegistration({ registrationId, input, connection });
        }
        await dao.insertAudit({ audit: audit(context, { tenantId,
          action: creating ? "GST_REGISTRATION_CREATED" : "GST_REGISTRATION_UPDATED",
          entityType: "GST_REGISTRATION", entityId: registrationId,
          afterData: { gstin: input.gstin, legalName: input.legalName, stateCode: input.stateCode,
            status: input.status, storeId: input.storeId || null } }), connection });
      });
      return getWorkspace(tenantId);
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") fail("GSTIN_EXISTS", "This GSTIN is already configured.", 409, "gstin");
      throw error;
    }
  }

  async function saveCategory(tenantId, categoryId, input, context) {
    const creating = !categoryId;
    try {
      await transaction(tenantId, async (connection) => {
        if (creating) {
          categoryId = createId();
          await dao.insertCategory({ category: { id: categoryId, tenantId, ...input }, connection });
        } else {
          if (!await dao.findCategory({ tenantId, categoryId, connection, forUpdate: true })) {
            fail("TAX_CATEGORY_NOT_FOUND", "Tax category was not found.", 404);
          }
          await dao.updateCategory({ categoryId, input, connection });
        }
        await dao.insertAudit({ audit: audit(context, { tenantId,
          action: creating ? "TAX_CATEGORY_CREATED" : "TAX_CATEGORY_UPDATED",
          entityType: "TAX_CATEGORY", entityId: categoryId,
          afterData: { code: input.code, name: input.name, hsnSacCode: input.hsnSacCode,
            supplyType: input.supplyType, status: input.status } }), connection });
      });
      return getWorkspace(tenantId);
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") fail("TAX_CATEGORY_CODE_EXISTS", "This tax category code is already in use.", 409, "code");
      throw error;
    }
  }

  async function createRate(tenantId, categoryId, input, context) {
    await transaction(tenantId, async (connection) => {
      if (!await dao.findCategory({ tenantId, categoryId, connection })) {
        fail("TAX_CATEGORY_NOT_FOUND", "Tax category was not found.", 404);
      }
      const rateId = createId();
      await dao.insertRate({ rate: { id: rateId, tenantId, categoryId, ...input }, connection });
      await dao.insertAudit({ audit: audit(context, { tenantId, action: "TAX_RATE_CREATED",
        entityType: "TAX_RATE", entityId: rateId,
        afterData: { categoryId, gstRate: input.gstRate, cessRate: input.cessRate,
          effectiveFrom: input.effectiveFrom, status: input.status } }), connection });
    });
    return getWorkspace(tenantId);
  }

  async function updateRate(tenantId, rateId, input, context) {
    await transaction(tenantId, async (connection) => {
      const current = await dao.findRate({ tenantId, rateId, connection, forUpdate: true });
      if (!current) fail("TAX_RATE_NOT_FOUND", "Tax rate was not found.", 404);
      await dao.updateRate({ rateId, input, connection });
      await dao.insertAudit({ audit: audit(context, { tenantId, action: "TAX_RATE_UPDATED",
        entityType: "TAX_RATE", entityId: rateId,
        afterData: { categoryId: current.categoryId, gstRate: input.gstRate, cessRate: input.cessRate,
          effectiveFrom: input.effectiveFrom, status: input.status } }), connection });
    });
    return getWorkspace(tenantId);
  }

  async function saveInvoiceSeries(tenantId, seriesId, input, context) {
    const creating = !seriesId;
    try {
      await transaction(tenantId, async (connection) => {
        if (!await dao.findRegistration({ tenantId, registrationId: input.registrationId, connection })) {
          fail("GST_REGISTRATION_NOT_FOUND", "Select a GST registration belonging to this workspace.", 422, "registrationId");
        }
        if (creating) {
          seriesId = createId();
          await dao.insertInvoiceSeries({ series: { id: seriesId, tenantId, ...input }, connection });
        } else {
          const current = await dao.findInvoiceSeries({ tenantId, seriesId, connection, forUpdate: true });
          if (!current) fail("INVOICE_SERIES_NOT_FOUND", "Invoice series was not found.", 404);
          if (current.version !== input.version) {
            fail("INVOICE_SERIES_VERSION_CONFLICT", "This invoice series changed after you opened it. Reload and try again.", 409);
          }
          if (!await dao.updateInvoiceSeries({ tenantId, seriesId, input, connection })) {
            fail("INVOICE_SERIES_VERSION_CONFLICT", "This invoice series changed after you opened it. Reload and try again.", 409);
          }
        }
        await dao.insertAudit({ audit: audit(context, { tenantId,
          action: creating ? "INVOICE_SERIES_CREATED" : "INVOICE_SERIES_UPDATED",
          entityType: "INVOICE_SERIES", entityId: seriesId,
          afterData: { registrationId: input.registrationId, documentType: input.documentType,
            financialYear: input.financialYear, prefix: input.prefix,
            nextNumber: input.nextNumber, numberPadding: input.numberPadding } }), connection });
      });
      return getWorkspace(tenantId);
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        fail("INVOICE_SERIES_EXISTS", "This registration already has the same series for that document type and financial year.", 409, "prefix");
      }
      throw error;
    }
  }

  async function issueTaxInvoice(tenantId, input, context) {
    await transaction(tenantId, async (connection) => {
      const sellerOrder = await dao.findSellerOrderForInvoice({ tenantId,
        sellerOrderId: input.sellerOrderId, connection });
      if (!sellerOrder) fail("SELLER_ORDER_NOT_FOUND", "Select a completed first-party seller order.", 404, "sellerOrderId");
      if (sellerOrder.status !== "COMPLETED") {
        fail("SELLER_ORDER_NOT_COMPLETED", "Complete the seller order before issuing its tax invoice.", 409, "sellerOrderId");
      }
      if (sellerOrder.hasInvoice) {
        fail("TAX_INVOICE_ALREADY_ISSUED", "A tax invoice has already been issued for this seller order.", 409, "sellerOrderId");
      }
      if (sellerOrder.currency !== "INR") {
        fail("TAX_DOCUMENT_CURRENCY_UNSUPPORTED", "The first release can issue tax documents only in INR.", 422, "sellerOrderId");
      }
      const series = await dao.findInvoiceSeriesForIssue({ tenantId, seriesId: input.seriesId,
        documentDate: input.documentDate, connection });
      if (!series || series.documentType !== "TAX_INVOICE") {
        fail("TAX_INVOICE_SERIES_NOT_FOUND", "Select an active tax-invoice series.", 422, "seriesId");
      }
      if (series.storeId && series.storeId !== sellerOrder.storeId) {
        fail("TAX_REGISTRATION_STORE_MISMATCH", "The selected GST registration does not apply to this order's store.", 422, "seriesId");
      }
      const financialYear = financialYearFor(input.documentDate);
      if (series.financialYear !== financialYear) {
        fail("TAX_INVOICE_FINANCIAL_YEAR_MISMATCH", `Use an invoice series configured for ${financialYear}.`, 422, "seriesId");
      }
      const placeState = placeOfSupply(sellerOrder.billingAddress || sellerOrder.shippingAddress);
      if (!placeState) {
        fail("TAX_PLACE_OF_SUPPLY_MISSING", "The order address does not contain a valid Indian state code.", 422, "sellerOrderId");
      }
      const orderItems = await dao.listSellerOrderItemsForInvoice({ tenantId,
        sellerOrderId: sellerOrder.id, connection });
      if (!orderItems.length) fail("TAX_INVOICE_ITEMS_MISSING", "The seller order has no invoiceable items.", 409, "sellerOrderId");
      const missingHsn = orderItems.find((item) => !item.hsnSacCode);
      if (missingHsn) {
        fail("TAX_HSN_SAC_MISSING", `${missingHsn.productName} does not have an HSN/SAC code.`, 422, "sellerOrderId");
      }
      const items = orderItems.map((item, index) => ({ ...item, id: createId(), orderItemId: item.id,
        lineNumber: index + 1, description: item.variantName
          ? `${item.productName} - ${item.variantName}` : item.productName }));
      const shipping = new Decimal(sellerOrder.shippingTotal || 0);
      if (shipping.greaterThan(0)) {
        items.push({ id: createId(), orderItemId: null, lineNumber: items.length + 1,
          description: "Delivery charges", hsnSacCode: null, quantity: "1", uomCode: "NOS",
          unitPrice: shipping.toFixed(4), discountAmount: "0.0000", taxableAmount: shipping.toFixed(4),
          cgstRate: "0", cgstAmount: "0.0000", sgstRate: "0", sgstAmount: "0.0000",
          igstRate: "0", igstAmount: "0.0000", cessRate: "0", cessAmount: "0.0000",
          lineTotal: shipping.toFixed(4) });
      }
      const sum = (field) => items.reduce((total, item) => total.plus(item[field] || 0), new Decimal(0));
      const grandTotal = sum("lineTotal");
      if (grandTotal.minus(sellerOrder.grandTotal).abs().greaterThan("0.01")) {
        fail("TAX_INVOICE_TOTAL_MISMATCH", "Seller-order totals do not reconcile with its invoice lines.", 409, "sellerOrderId");
      }
      const documentId = createId();
      const documentNumber = `${series.prefix}${String(series.nextNumber).padStart(series.numberPadding, "0")}`;
      if (!await dao.incrementInvoiceSeries({ seriesId: series.id, version: series.version, connection })) {
        fail("INVOICE_SERIES_VERSION_CONFLICT", "The invoice number was allocated elsewhere. Try again.", 409, "seriesId");
      }
      await dao.insertTaxDocument({ document: { id: documentId, tenantId,
        orderId: sellerOrder.orderId, sellerOrderId: sellerOrder.id, merchantId: sellerOrder.merchantId,
        registrationId: series.registrationId, seriesId: series.id, number: documentNumber,
        documentDate: input.documentDate, financialYear, placeOfSupplyStateCode: placeState,
        currency: sellerOrder.currency, taxableTotal: sum("taxableAmount").toFixed(4),
        cgstTotal: sum("cgstAmount").toFixed(4), sgstTotal: sum("sgstAmount").toFixed(4),
        igstTotal: sum("igstAmount").toFixed(4), cessTotal: sum("cessAmount").toFixed(4),
        grandTotal: grandTotal.toFixed(4), actorUserId: context.actorUserId }, connection });
      await dao.insertTaxDocumentItems({ documentId, items, connection });
      await dao.insertAudit({ audit: audit(context, { tenantId, action: "TAX_INVOICE_ISSUED",
        entityType: "TAX_DOCUMENT", entityId: documentId,
        afterData: { documentNumber, documentDate: input.documentDate,
          sellerOrderId: sellerOrder.id, orderId: sellerOrder.orderId,
          grandTotal: grandTotal.toFixed(4), currency: sellerOrder.currency } }), connection });
    });
    return getWorkspace(tenantId);
  }

  async function getTaxDocument(tenantId, documentId) {
    const document = await dao.getTaxDocumentDetail({ tenantId, documentId });
    if (!document) fail("TAX_DOCUMENT_NOT_FOUND", "The tax document was not found.", 404);
    return document;
  }

  async function getTaxDocumentPdf(tenantId, documentId) {
    const document = await getTaxDocument(tenantId, documentId);
    const buffer = await pdfRenderer(document);
    const safeNumber = document.documentNumber.replace(/[^A-Za-z0-9_-]+/g, "-");
    return { buffer, filename: `${document.documentType.toLowerCase()}-${safeNumber}.pdf` };
  }

  return {
    getWorkspace,
    createRegistration: (tenantId, input, context) => saveRegistration(tenantId, null, input, context),
    updateRegistration: (tenantId, registrationId, input, context) => saveRegistration(tenantId, registrationId, input, context),
    createCategory: (tenantId, input, context) => saveCategory(tenantId, null, input, context),
    updateCategory: (tenantId, categoryId, input, context) => saveCategory(tenantId, categoryId, input, context),
    createRate, updateRate,
    createInvoiceSeries: (tenantId, input, context) => saveInvoiceSeries(tenantId, null, input, context),
    updateInvoiceSeries: (tenantId, seriesId, input, context) => saveInvoiceSeries(tenantId, seriesId, input, context),
    issueTaxInvoice, getTaxDocument, getTaxDocumentPdf
  };
}

const service = createTaxesService();
export const { getWorkspace, createRegistration, updateRegistration, createCategory,
  updateCategory, createRate, updateRate, createInvoiceSeries, updateInvoiceSeries,
  issueTaxInvoice, getTaxDocument, getTaxDocumentPdf } = service;
