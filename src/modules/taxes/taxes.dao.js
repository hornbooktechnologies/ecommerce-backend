import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";

function dateValue(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function number(value) { return Number(value || 0); }

function json(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapRegistration(row) {
  if (!row) return null;
  return {
    id: bufferToUuid(row.id), storeId: bufferToUuid(row.store_id), storeName: row.store_name || null,
    gstin: row.gstin, legalName: row.legal_name, tradeName: row.trade_name || "",
    registrationType: row.registration_type, stateCode: row.state_code, stateName: row.state_name,
    line1: row.line1, line2: row.line2 || "", city: row.city, postalCode: row.postal_code,
    effectiveFrom: dateValue(row.effective_from), effectiveTo: dateValue(row.effective_to),
    eInvoiceEnabled: Boolean(row.einvoice_enabled), eWayBillEnabled: Boolean(row.ewaybill_enabled),
    status: row.status, updatedAt: row.updated_at
  };
}

function mapRate(row) {
  return {
    id: bufferToUuid(row.id), categoryId: bufferToUuid(row.tax_category_id),
    gstRate: number(row.igst_rate), cgstRate: number(row.cgst_rate), sgstRate: number(row.sgst_rate),
    igstRate: number(row.igst_rate), cessRate: number(row.cess_rate), cessAmount: number(row.cess_amount),
    effectiveFrom: dateValue(row.effective_from), effectiveTo: dateValue(row.effective_to),
    status: row.status, updatedAt: row.updated_at
  };
}

function mapCategory(row, rates = []) {
  return {
    id: bufferToUuid(row.id), code: row.code, name: row.name, supplyType: row.supply_type,
    hsnSacCode: row.hsn_sac_code || "", status: row.status,
    productCount: number(row.product_count), rates: rates.filter((rate) => rate.categoryId === bufferToUuid(row.id))
  };
}

function mapInvoiceSeries(row) {
  const nextNumber = Number(row.next_number);
  const numberPadding = Number(row.number_padding);
  return {
    id: bufferToUuid(row.id), registrationId: bufferToUuid(row.gst_registration_id),
    registrationGstin: row.gstin, registrationName: row.legal_name,
    documentType: row.document_type, financialYear: row.financial_year, prefix: row.prefix,
    nextNumber, numberPadding, version: Number(row.version), documentCount: number(row.document_count),
    nextDocumentNumber: `${row.prefix}${String(nextNumber).padStart(numberPadding, "0")}`,
    updatedAt: row.updated_at
  };
}

function mapTaxDocument(row) {
  return {
    id: bufferToUuid(row.id), orderId: bufferToUuid(row.customer_order_id),
    sellerOrderId: bufferToUuid(row.seller_order_id), documentType: row.document_type,
    documentNumber: row.document_number, documentDate: dateValue(row.document_date),
    financialYear: row.financial_year, status: row.status,
    placeOfSupplyStateCode: row.place_of_supply_state_code, currency: row.currency,
    taxableTotal: number(row.taxable_total), cgstTotal: number(row.cgst_total),
    sgstTotal: number(row.sgst_total), igstTotal: number(row.igst_total),
    cessTotal: number(row.cess_total), grandTotal: number(row.grand_total),
    orderNumber: row.order_number, sellerOrderNumber: row.seller_order_number,
    merchantName: row.merchant_name, registrationGstin: row.gstin,
    customerName: row.customer_name || "Customer", issuedAt: row.issued_at
  };
}

function mapTaxDocumentItem(row) {
  return {
    id: bufferToUuid(row.id), orderItemId: bufferToUuid(row.order_item_id),
    lineNumber: Number(row.line_number), description: row.description,
    hsnSacCode: row.hsn_sac_code || "", quantity: number(row.quantity),
    uomCode: row.uom_code, unitPrice: number(row.unit_price),
    discountAmount: number(row.discount_amount), taxableAmount: number(row.taxable_amount),
    cgstRate: number(row.cgst_rate), cgstAmount: number(row.cgst_amount),
    sgstRate: number(row.sgst_rate), sgstAmount: number(row.sgst_amount),
    igstRate: number(row.igst_rate), igstAmount: number(row.igst_amount),
    cessRate: number(row.cess_rate), cessAmount: number(row.cess_amount),
    lineTotal: number(row.line_total)
  };
}

function mapInvoiceCandidate(row) {
  return {
    sellerOrderId: bufferToUuid(row.id), orderId: bufferToUuid(row.customer_order_id),
    orderNumber: row.order_number, sellerOrderNumber: row.seller_order_number,
    customerName: row.customer_name || "Customer", completedAt: row.completed_at,
    grandTotal: number(row.grand_total), itemCount: Number(row.item_count), currency: row.currency,
    storeName: row.store_name, merchantName: row.merchant_name
  };
}

export async function getWorkspace({ tenantId, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const [[registrations], [categories], [rates], [stores], [invoiceSeries], [taxDocuments],
    [invoiceCandidates], [summaryRows]] = await Promise.all([
    connection.execute(
      `SELECT gr.id, gr.store_id, s.name AS store_name, gr.gstin, gr.legal_name, gr.trade_name,
              gr.registration_type, gr.state_code, a.state_name, a.line1, a.line2, a.city, a.postal_code,
              gr.effective_from, gr.effective_to, gr.einvoice_enabled, gr.ewaybill_enabled,
              gr.status, gr.updated_at
         FROM gst_registrations gr
         JOIN addresses a ON a.id = gr.address_id
         LEFT JOIN stores s ON s.id = gr.store_id
        WHERE gr.tenant_id = ? AND gr.merchant_id IS NULL
        ORDER BY (gr.status = 'ACTIVE') DESC, gr.legal_name`, [tenant]),
    connection.execute(
      `SELECT tc.id, tc.code, tc.name, tc.supply_type, tc.hsn_sac_code, tc.status,
              COUNT(DISTINCT p.id) AS product_count
         FROM tax_categories tc
         LEFT JOIN products p ON p.tax_category_id = tc.id AND p.deleted_at IS NULL
        WHERE tc.tenant_id = ?
        GROUP BY tc.id, tc.code, tc.name, tc.supply_type, tc.hsn_sac_code, tc.status
        ORDER BY (tc.status = 'ACTIVE') DESC, tc.name`, [tenant]),
    connection.execute(
      `SELECT tr.id, tr.tax_category_id, tr.cgst_rate, tr.sgst_rate, tr.igst_rate,
              tr.cess_rate, tr.cess_amount, tr.effective_from, tr.effective_to, tr.status, tr.updated_at
         FROM tax_rates tr
        WHERE tr.tenant_id = ? AND tr.transaction_type = 'SALE'
        ORDER BY tr.effective_from DESC, tr.created_at DESC`, [tenant]),
    connection.execute(
      `SELECT id, code, name, status FROM stores
        WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY name`, [tenant]),
    connection.execute(
      `SELECT ins.id, ins.gst_registration_id, gr.gstin, gr.legal_name, ins.document_type,
              ins.financial_year, ins.prefix, ins.next_number, ins.number_padding, ins.version,
              ins.updated_at, COUNT(td.id) AS document_count
         FROM invoice_series ins
         JOIN gst_registrations gr ON gr.id = ins.gst_registration_id
         LEFT JOIN tax_documents td ON td.invoice_series_id = ins.id
        WHERE ins.tenant_id = ? AND gr.tenant_id = ? AND gr.merchant_id IS NULL
        GROUP BY ins.id, ins.gst_registration_id, gr.gstin, gr.legal_name, ins.document_type,
                 ins.financial_year, ins.prefix, ins.next_number, ins.number_padding, ins.version,
                 ins.updated_at
        ORDER BY ins.financial_year DESC, ins.document_type, ins.prefix`, [tenant, tenant]),
    connection.execute(
      `SELECT td.id, td.customer_order_id, td.seller_order_id, td.document_type,
              td.document_number, td.document_date, td.financial_year, td.status,
              td.place_of_supply_state_code, td.currency, td.taxable_total, td.cgst_total,
              td.sgst_total, td.igst_total, td.cess_total, td.grand_total, td.issued_at,
              co.order_number, so.seller_order_number, m.display_name AS merchant_name,
              gr.gstin, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
                JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.name'))) AS customer_name
         FROM tax_documents td
         JOIN customer_orders co ON co.id = td.customer_order_id
         LEFT JOIN seller_orders so ON so.id = td.seller_order_id
         JOIN merchants m ON m.id = td.merchant_id
         JOIN gst_registrations gr ON gr.id = td.gst_registration_id
         LEFT JOIN customers c ON c.id = co.customer_id
        WHERE td.tenant_id = ? AND td.document_type = 'TAX_INVOICE'
        ORDER BY td.issued_at DESC, td.id DESC LIMIT 50`, [tenant]),
    connection.execute(
      `SELECT so.id, so.customer_order_id, so.seller_order_number, so.completed_at,
              so.grand_total, co.order_number, co.currency, s.name AS store_name,
              m.display_name AS merchant_name,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
                JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.name'))) AS customer_name,
              COUNT(oi.id) AS item_count
         FROM seller_orders so
         JOIN customer_orders co ON co.id = so.customer_order_id AND co.tenant_id = so.tenant_id
         JOIN stores s ON s.id = co.store_id
         JOIN merchants m ON m.id = so.merchant_id AND m.merchant_type = 'FIRST_PARTY'
         LEFT JOIN customers c ON c.id = co.customer_id
         JOIN order_items oi ON oi.seller_order_id = so.id
        WHERE so.tenant_id = ? AND so.status = 'COMPLETED'
          AND NOT EXISTS (SELECT 1 FROM tax_documents td WHERE td.tenant_id = so.tenant_id
            AND td.seller_order_id = so.id AND td.document_type = 'TAX_INVOICE'
            AND td.status = 'ISSUED')
        GROUP BY so.id, so.customer_order_id, so.seller_order_number, so.completed_at,
                 so.grand_total, so.shipping_total, co.order_number, co.currency, s.name, m.display_name,
                 c.first_name, c.last_name, co.customer_snapshot
        HAVING ABS(so.grand_total - (SUM(oi.line_total) + so.shipping_total)) <= 0.01
           AND SUM(CASE WHEN oi.hsn_sac_code IS NULL
             OR JSON_UNQUOTE(JSON_EXTRACT(oi.product_snapshot, '$.tax.taxRateId')) IS NULL
             OR JSON_UNQUOTE(JSON_EXTRACT(oi.product_snapshot, '$.tax.sellerGstin')) IS NULL
             THEN 1 ELSE 0 END) = 0
        ORDER BY so.completed_at DESC, so.created_at DESC LIMIT 50`, [tenant]),
    connection.execute(
      `SELECT
         (SELECT COUNT(*) FROM gst_registrations gr WHERE gr.tenant_id = ? AND gr.merchant_id IS NULL AND gr.status = 'ACTIVE') AS active_registrations,
         (SELECT COUNT(*) FROM tax_categories tc WHERE tc.tenant_id = ? AND tc.status = 'ACTIVE') AS active_categories,
         (SELECT COUNT(*) FROM tax_rates tr WHERE tr.tenant_id = ? AND tr.status = 'ACTIVE'
           AND tr.transaction_type = 'SALE' AND tr.effective_from <= UTC_DATE()
           AND (tr.effective_to IS NULL OR tr.effective_to >= UTC_DATE())) AS active_rates,
         (SELECT COUNT(*) FROM products p LEFT JOIN tax_categories tc ON tc.id = p.tax_category_id
           WHERE p.tenant_id = ? AND p.deleted_at IS NULL
             AND (p.tax_category_id IS NULL OR COALESCE(NULLIF(p.hsn_sac_code, ''), NULLIF(tc.hsn_sac_code, '')) IS NULL)) AS products_missing_tax,
         (SELECT COUNT(*) FROM products p WHERE p.tenant_id = ? AND p.deleted_at IS NULL) AS total_products`,
      [tenant, tenant, tenant, tenant, tenant])
  ]);
  const mappedRates = rates.map(mapRate);
  const summary = summaryRows[0] || {};
  return {
    registrations: registrations.map(mapRegistration),
    categories: categories.map((row) => mapCategory(row, mappedRates)),
    invoiceSeries: invoiceSeries.map(mapInvoiceSeries),
    taxDocuments: taxDocuments.map(mapTaxDocument),
    invoiceCandidates: invoiceCandidates.map(mapInvoiceCandidate),
    stores: stores.map((row) => ({ id: bufferToUuid(row.id), code: row.code, name: row.name, status: row.status })),
    summary: {
      activeRegistrations: number(summary.active_registrations), activeCategories: number(summary.active_categories),
      activeRates: number(summary.active_rates), productsMissingTax: number(summary.products_missing_tax),
      totalProducts: number(summary.total_products)
    }
  };
}

export async function getTaxDocumentDetail({ tenantId, documentId, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const id = uuidToBuffer(documentId);
  const [[documents], [items]] = await Promise.all([
    connection.execute(
      `SELECT td.id, td.customer_order_id, td.seller_order_id, td.source_document_id,
              td.document_type, td.document_number, td.document_date, td.financial_year,
              td.status, td.place_of_supply_state_code, td.reverse_charge, td.currency,
              td.taxable_total, td.cgst_total, td.sgst_total, td.igst_total, td.cess_total,
              td.grand_total, td.irn, td.acknowledgement_number, td.acknowledgement_at,
              td.ewaybill_number, td.reason_code, td.issued_at,
              t.code AS tenant_code, t.display_name AS tenant_name,
              co.order_number, co.customer_snapshot, co.billing_address_snapshot,
              co.shipping_address_snapshot, s.code AS store_code, s.name AS store_name,
              so.seller_order_number, m.display_name AS merchant_name,
              m.logo_url AS merchant_logo_url,
              gr.gstin, gr.legal_name, gr.trade_name, gr.registration_type,
              gr.state_code AS seller_state_code, ga.line1 AS seller_line1,
              ga.line2 AS seller_line2, ga.city AS seller_city,
              ga.state_name AS seller_state_name, ga.postal_code AS seller_postal_code,
              source.document_number AS source_document_number,
              TRIM(CONCAT_WS(' ', issuer.first_name, issuer.last_name)) AS issued_by_name
         FROM tax_documents td
         JOIN tenants t ON t.id = td.tenant_id
         JOIN customer_orders co ON co.id = td.customer_order_id AND co.tenant_id = td.tenant_id
         JOIN stores s ON s.id = co.store_id
         LEFT JOIN seller_orders so ON so.id = td.seller_order_id
         JOIN merchants m ON m.id = td.merchant_id
         JOIN gst_registrations gr ON gr.id = td.gst_registration_id
         JOIN addresses ga ON ga.id = gr.address_id
         LEFT JOIN tax_documents source ON source.id = td.source_document_id
         LEFT JOIN users issuer ON issuer.id = td.issued_by
        WHERE td.tenant_id = ? AND td.id = ? LIMIT 1`, [tenant, id]),
    connection.execute(
      `SELECT id, order_item_id, line_number, description, hsn_sac_code, quantity,
              uom_code, unit_price, discount_amount, taxable_amount, cgst_rate, cgst_amount,
              sgst_rate, sgst_amount, igst_rate, igst_amount, cess_rate, cess_amount, line_total
         FROM tax_document_items WHERE tax_document_id = ? ORDER BY line_number`, [id])
  ]);
  const row = documents[0];
  if (!row) return null;
  return {
    ...mapTaxDocument({ ...row, customer_name: null, merchant_name: row.merchant_name,
      gstin: row.gstin }),
    reverseCharge: Boolean(row.reverse_charge), irn: row.irn || null,
    acknowledgementNumber: row.acknowledgement_number || null,
    acknowledgementAt: row.acknowledgement_at || null,
    ewaybillNumber: row.ewaybill_number || null, reasonCode: row.reason_code || null,
    sourceDocumentId: bufferToUuid(row.source_document_id),
    sourceDocumentNumber: row.source_document_number || null,
    issuedByName: row.issued_by_name || "System",
    tenant: { code: row.tenant_code, name: row.tenant_name },
    store: { code: row.store_code, name: row.store_name },
    seller: { legalName: row.legal_name, tradeName: row.trade_name || row.merchant_name,
      logoUrl: row.merchant_logo_url || null,
      gstin: row.gstin, registrationType: row.registration_type,
      stateCode: row.seller_state_code, address: { line1: row.seller_line1,
        line2: row.seller_line2 || "", city: row.seller_city,
        stateName: row.seller_state_name, postalCode: row.seller_postal_code, countryCode: "IN" } },
    buyer: { ...json(row.customer_snapshot), billingAddress: json(row.billing_address_snapshot),
      shippingAddress: json(row.shipping_address_snapshot) },
    items: items.map(mapTaxDocumentItem)
  };
}

export async function findInvoiceSeriesForIssue({ tenantId, seriesId, documentDate, connection }) {
  const [rows] = await connection.execute(
    `SELECT ins.id, ins.gst_registration_id, ins.document_type, ins.financial_year,
            ins.prefix, ins.next_number, ins.number_padding, ins.version,
            gr.store_id, gr.state_code, gr.status, gr.effective_from, gr.effective_to
       FROM invoice_series ins JOIN gst_registrations gr ON gr.id = ins.gst_registration_id
      WHERE ins.tenant_id = ? AND ins.id = ? AND gr.tenant_id = ? AND gr.merchant_id IS NULL
        AND gr.status = 'ACTIVE' AND (gr.effective_from IS NULL OR gr.effective_from <= ?)
        AND (gr.effective_to IS NULL OR gr.effective_to >= ?) LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(seriesId), uuidToBuffer(tenantId), documentDate, documentDate]);
  if (!rows[0]) return null;
  return { id: bufferToUuid(rows[0].id), registrationId: bufferToUuid(rows[0].gst_registration_id),
    storeId: bufferToUuid(rows[0].store_id), documentType: rows[0].document_type,
    financialYear: rows[0].financial_year, prefix: rows[0].prefix,
    nextNumber: Number(rows[0].next_number), numberPadding: Number(rows[0].number_padding),
    version: Number(rows[0].version), stateCode: rows[0].state_code };
}

export async function findSellerOrderForInvoice({ tenantId, sellerOrderId, connection }) {
  const [rows] = await connection.execute(
    `SELECT so.id, so.customer_order_id, so.merchant_id, so.seller_order_number,
            so.status, so.shipping_total, so.grand_total, co.store_id, co.order_number,
            co.currency, co.billing_address_snapshot, co.shipping_address_snapshot,
            EXISTS(SELECT 1 FROM tax_documents td WHERE td.tenant_id = so.tenant_id
              AND td.seller_order_id = so.id AND td.document_type = 'TAX_INVOICE'
              AND td.status = 'ISSUED') AS has_invoice
       FROM seller_orders so
       JOIN customer_orders co ON co.id = so.customer_order_id AND co.tenant_id = so.tenant_id
       JOIN merchants m ON m.id = so.merchant_id AND m.tenant_id = so.tenant_id
      WHERE so.tenant_id = ? AND so.id = ? AND m.merchant_type = 'FIRST_PARTY'
      LIMIT 1 FOR UPDATE`, [uuidToBuffer(tenantId), uuidToBuffer(sellerOrderId)]);
  if (!rows[0]) return null;
  return { id: bufferToUuid(rows[0].id), orderId: bufferToUuid(rows[0].customer_order_id),
    merchantId: bufferToUuid(rows[0].merchant_id), storeId: bufferToUuid(rows[0].store_id),
    number: rows[0].seller_order_number, orderNumber: rows[0].order_number,
    status: rows[0].status, currency: rows[0].currency, shippingTotal: String(rows[0].shipping_total),
    grandTotal: String(rows[0].grand_total), hasInvoice: Boolean(rows[0].has_invoice),
    billingAddress: typeof rows[0].billing_address_snapshot === "string"
      ? JSON.parse(rows[0].billing_address_snapshot) : rows[0].billing_address_snapshot,
    shippingAddress: typeof rows[0].shipping_address_snapshot === "string"
      ? JSON.parse(rows[0].shipping_address_snapshot) : rows[0].shipping_address_snapshot };
}

export async function listSellerOrderItemsForInvoice({ tenantId, sellerOrderId, connection }) {
  const [rows] = await connection.execute(
    `SELECT oi.id, oi.product_name, oi.variant_name, oi.hsn_sac_code, oi.quantity,
            oi.unit_price, oi.discount_total, oi.taxable_amount, oi.cgst_rate, oi.cgst_amount,
            oi.sgst_rate, oi.sgst_amount, oi.igst_rate, oi.igst_amount, oi.cess_rate,
            oi.cess_amount, oi.line_total, COALESCE(oi.hsn_sac_code, p.hsn_sac_code) AS resolved_hsn,
            COALESCE(uom.code, 'NOS') AS uom_code
       FROM order_items oi
       LEFT JOIN product_variants pv ON pv.id = oi.variant_id
       LEFT JOIN products p ON p.id = pv.product_id
       LEFT JOIN units_of_measure uom ON uom.id = pv.selling_uom_id
      WHERE oi.tenant_id = ? AND oi.seller_order_id = ?
      ORDER BY oi.created_at, oi.id`, [uuidToBuffer(tenantId), uuidToBuffer(sellerOrderId)]);
  return rows.map((row) => ({ id: bufferToUuid(row.id), productName: row.product_name,
    variantName: row.variant_name || "", hsnSacCode: row.resolved_hsn || null,
    quantity: String(row.quantity), uomCode: row.uom_code, unitPrice: String(row.unit_price),
    discountAmount: String(row.discount_total), taxableAmount: String(row.taxable_amount),
    cgstRate: String(row.cgst_rate), cgstAmount: String(row.cgst_amount),
    sgstRate: String(row.sgst_rate), sgstAmount: String(row.sgst_amount),
    igstRate: String(row.igst_rate), igstAmount: String(row.igst_amount),
    cessRate: String(row.cess_rate), cessAmount: String(row.cess_amount),
    lineTotal: String(row.line_total) }));
}

export async function incrementInvoiceSeries({ seriesId, version, connection }) {
  const [result] = await connection.execute(
    `UPDATE invoice_series SET next_number = next_number + 1, version = version + 1
      WHERE id = ? AND version = ?`, [uuidToBuffer(seriesId), version]);
  return result.affectedRows === 1;
}

export async function insertTaxDocument({ document, connection }) {
  await connection.execute(
    `INSERT INTO tax_documents (id, tenant_id, customer_order_id, seller_order_id, merchant_id,
       gst_registration_id, invoice_series_id, document_type, document_number, document_date,
       financial_year, status, place_of_supply_state_code, reverse_charge, currency,
       taxable_total, cgst_total, sgst_total, igst_total, cess_total, grand_total, issued_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'TAX_INVOICE', ?, ?, ?, 'ISSUED', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(document.id), uuidToBuffer(document.tenantId), uuidToBuffer(document.orderId),
      uuidToBuffer(document.sellerOrderId), uuidToBuffer(document.merchantId),
      uuidToBuffer(document.registrationId), uuidToBuffer(document.seriesId), document.number,
      document.documentDate, document.financialYear, document.placeOfSupplyStateCode,
      document.currency, document.taxableTotal, document.cgstTotal, document.sgstTotal,
      document.igstTotal, document.cessTotal, document.grandTotal, uuidToBuffer(document.actorUserId)]);
}

export async function insertTaxDocumentItems({ documentId, items, connection }) {
  for (const item of items) {
    await connection.execute(
      `INSERT INTO tax_document_items (id, tax_document_id, order_item_id, line_number,
         description, hsn_sac_code, quantity, uom_code, unit_price, discount_amount,
         taxable_amount, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate,
         igst_amount, cess_rate, cess_amount, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidToBuffer(item.id), uuidToBuffer(documentId), item.orderItemId ? uuidToBuffer(item.orderItemId) : null,
        item.lineNumber, item.description, item.hsnSacCode || null, item.quantity, item.uomCode,
        item.unitPrice, item.discountAmount, item.taxableAmount, item.cgstRate, item.cgstAmount,
        item.sgstRate, item.sgstAmount, item.igstRate, item.igstAmount, item.cessRate,
        item.cessAmount, item.lineTotal]);
  }
}

export async function findInvoiceSeries({ tenantId, seriesId, connection = getPrimaryPool(), forUpdate = false }) {
  const [rows] = await connection.execute(
    `SELECT id, version FROM invoice_series WHERE tenant_id = ? AND id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(seriesId)]);
  return rows[0] ? { id: bufferToUuid(rows[0].id), version: Number(rows[0].version) } : null;
}

export async function insertInvoiceSeries({ series, connection }) {
  await connection.execute(
    `INSERT INTO invoice_series (id, tenant_id, gst_registration_id, document_type, financial_year,
       prefix, next_number, number_padding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(series.id), uuidToBuffer(series.tenantId), uuidToBuffer(series.registrationId),
      series.documentType, series.financialYear, series.prefix, series.nextNumber, series.numberPadding]);
}

export async function updateInvoiceSeries({ tenantId, seriesId, input, connection }) {
  const [result] = await connection.execute(
    `UPDATE invoice_series SET gst_registration_id = ?, document_type = ?, financial_year = ?,
       prefix = ?, next_number = ?, number_padding = ?, version = version + 1
      WHERE tenant_id = ? AND id = ? AND version = ?`,
    [uuidToBuffer(input.registrationId), input.documentType, input.financialYear, input.prefix,
      input.nextNumber, input.numberPadding, uuidToBuffer(tenantId), uuidToBuffer(seriesId), input.version]);
  return result.affectedRows === 1;
}

export async function findStore({ tenantId, storeId, connection }) {
  if (!storeId) return null;
  const [rows] = await connection.execute(
    "SELECT id FROM stores WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1",
    [uuidToBuffer(tenantId), uuidToBuffer(storeId)]);
  return rows[0] ? bufferToUuid(rows[0].id) : null;
}

export async function findRegistration({ tenantId, registrationId, connection = getPrimaryPool(), forUpdate = false }) {
  const [rows] = await connection.execute(
    `SELECT id, address_id FROM gst_registrations WHERE tenant_id = ? AND id = ? AND merchant_id IS NULL LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(registrationId)]);
  return rows[0] ? { id: bufferToUuid(rows[0].id), addressId: bufferToUuid(rows[0].address_id) } : null;
}

export async function insertAddress({ address, connection }) {
  await connection.execute(
    `INSERT INTO addresses (id, tenant_id, company_name, line1, line2, city, state_code, state_name, postal_code, country_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN')`,
    [uuidToBuffer(address.id), uuidToBuffer(address.tenantId), address.legalName, address.line1,
      address.line2 || null, address.city, address.stateCode, address.stateName, address.postalCode]);
}

export async function updateAddress({ addressId, input, connection }) {
  await connection.execute(
    `UPDATE addresses SET company_name = ?, line1 = ?, line2 = ?, city = ?, state_code = ?, state_name = ?, postal_code = ?
      WHERE id = ?`,
    [input.legalName, input.line1, input.line2 || null, input.city, input.stateCode,
      input.stateName, input.postalCode, uuidToBuffer(addressId)]);
}

export async function insertRegistration({ registration, connection }) {
  await connection.execute(
    `INSERT INTO gst_registrations (id, tenant_id, store_id, merchant_id, gstin, legal_name, trade_name,
       registration_type, state_code, address_id, status, effective_from, effective_to, einvoice_enabled, ewaybill_enabled)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(registration.id), uuidToBuffer(registration.tenantId),
      registration.storeId ? uuidToBuffer(registration.storeId) : null, registration.gstin,
      registration.legalName, registration.tradeName || null, registration.registrationType,
      registration.stateCode, uuidToBuffer(registration.addressId), registration.status,
      registration.effectiveFrom || null, registration.effectiveTo || null,
      registration.eInvoiceEnabled, registration.eWayBillEnabled]);
}

export async function updateRegistration({ registrationId, input, connection }) {
  await connection.execute(
    `UPDATE gst_registrations SET store_id = ?, gstin = ?, legal_name = ?, trade_name = ?,
       registration_type = ?, state_code = ?, status = ?, effective_from = ?, effective_to = ?,
       einvoice_enabled = ?, ewaybill_enabled = ? WHERE id = ?`,
    [input.storeId ? uuidToBuffer(input.storeId) : null, input.gstin, input.legalName,
      input.tradeName || null, input.registrationType, input.stateCode, input.status,
      input.effectiveFrom || null, input.effectiveTo || null, input.eInvoiceEnabled,
      input.eWayBillEnabled, uuidToBuffer(registrationId)]);
}

export async function findCategory({ tenantId, categoryId, connection = getPrimaryPool(), forUpdate = false }) {
  const [rows] = await connection.execute(
    `SELECT id FROM tax_categories WHERE tenant_id = ? AND id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(categoryId)]);
  return rows[0] ? bufferToUuid(rows[0].id) : null;
}

export async function insertCategory({ category, connection }) {
  await connection.execute(
    `INSERT INTO tax_categories (id, tenant_id, code, name, supply_type, hsn_sac_code, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(category.id), uuidToBuffer(category.tenantId), category.code, category.name,
      category.supplyType, category.hsnSacCode, category.status]);
}

export async function updateCategory({ categoryId, input, connection }) {
  await connection.execute(
    `UPDATE tax_categories SET code = ?, name = ?, supply_type = ?, hsn_sac_code = ?, status = ? WHERE id = ?`,
    [input.code, input.name, input.supplyType, input.hsnSacCode, input.status, uuidToBuffer(categoryId)]);
}

export async function findRate({ tenantId, rateId, connection = getPrimaryPool(), forUpdate = false }) {
  const [rows] = await connection.execute(
    `SELECT tr.id, tr.tax_category_id FROM tax_rates tr JOIN tax_categories tc ON tc.id = tr.tax_category_id
      WHERE tr.tenant_id = ? AND tr.id = ? AND tc.tenant_id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(rateId), uuidToBuffer(tenantId)]);
  return rows[0] ? { id: bufferToUuid(rows[0].id), categoryId: bufferToUuid(rows[0].tax_category_id) } : null;
}

function rateValues(rate) {
  const half = Number(rate.gstRate) / 2;
  return [half, half, Number(rate.gstRate), Number(rate.cessRate), Number(rate.cessAmount),
    rate.status, rate.effectiveFrom, rate.effectiveTo || null];
}

export async function insertRate({ rate, connection }) {
  await connection.execute(
    `INSERT INTO tax_rates (id, tenant_id, tax_category_id, state_code, transaction_type,
       cgst_rate, sgst_rate, igst_rate, cess_rate, cess_amount, status, effective_from, effective_to)
     VALUES (?, ?, ?, NULL, 'SALE', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(rate.id), uuidToBuffer(rate.tenantId), uuidToBuffer(rate.categoryId), ...rateValues(rate)]);
}

export async function updateRate({ rateId, input, connection }) {
  await connection.execute(
    `UPDATE tax_rates SET cgst_rate = ?, sgst_rate = ?, igst_rate = ?, cess_rate = ?, cess_amount = ?,
       status = ?, effective_from = ?, effective_to = ? WHERE id = ?`,
    [...rateValues(input), uuidToBuffer(rateId)]);
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(
    `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type, entity_id,
       request_id, ip_address, user_agent, after_data) VALUES (?, ?, ?, 'USER', ?, ?, ?, ?, INET6_ATON(?), ?, ?)`,
    [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId), audit.action,
      audit.entityType, uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress,
      audit.userAgent, JSON.stringify(audit.afterData)]);
}

export async function findDemoSeedScope({ connection = getPrimaryPool() } = {}) {
  const [rows] = await connection.execute(
    `SELECT t.id AS tenant_id, t.code AS tenant_code, t.display_name,
            u.id AS actor_user_id, s.id AS store_id, s.name AS store_name,
            a.line1, a.line2, a.city, a.state_code, a.state_name, a.postal_code
       FROM tenants t
       JOIN tenant_memberships tm ON tm.tenant_id = t.id
        AND tm.membership_type = 'OWNER' AND tm.status = 'ACTIVE'
       JOIN users u ON u.id = tm.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
       JOIN stores s ON s.tenant_id = t.id AND s.status = 'ACTIVE' AND s.deleted_at IS NULL
       LEFT JOIN addresses a ON a.id = s.business_address_id
      WHERE t.status = 'ACTIVE' AND t.deleted_at IS NULL
      ORDER BY t.created_at, s.created_at LIMIT 1`
  );
  if (!rows[0]) return null;
  return {
    tenantId: bufferToUuid(rows[0].tenant_id), tenantCode: rows[0].tenant_code,
    tenantName: rows[0].display_name, actorUserId: bufferToUuid(rows[0].actor_user_id),
    storeId: bufferToUuid(rows[0].store_id), storeName: rows[0].store_name,
    address: { line1: rows[0].line1 || "Demo business address", line2: rows[0].line2 || "",
      city: rows[0].city || "Bengaluru", stateCode: rows[0].state_code || "29",
      stateName: rows[0].state_name || "Karnataka", postalCode: rows[0].postal_code || "560001" }
  };
}

export async function assignDemoTaxCategory({ tenantId, categoryId, hsnSacCodes, connection }) {
  if (!hsnSacCodes.length) return { products: 0, offers: 0 };
  const placeholders = hsnSacCodes.map(() => "?").join(", ");
  const parameters = [uuidToBuffer(categoryId), uuidToBuffer(tenantId), ...hsnSacCodes];
  const [products] = await connection.execute(
    `UPDATE products p
       LEFT JOIN tax_categories current_category ON current_category.id = p.tax_category_id
        SET p.tax_category_id = ?
      WHERE p.tenant_id = ? AND p.hsn_sac_code IN (${placeholders}) AND p.deleted_at IS NULL
        AND (current_category.id IS NULL OR current_category.code = 'GST-GOODS'
          OR current_category.code LIKE 'DEMO-GST-%')`, parameters
  );
  const [offers] = await connection.execute(
    `UPDATE seller_offers so
       JOIN product_variants pv ON pv.id = so.variant_id
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN tax_categories current_category ON current_category.id = so.tax_category_id
        SET so.tax_category_id = ?
      WHERE so.tenant_id = ? AND p.hsn_sac_code IN (${placeholders}) AND so.deleted_at IS NULL
        AND (current_category.id IS NULL OR current_category.code = 'GST-GOODS'
          OR current_category.code LIKE 'DEMO-GST-%')`, parameters
  );
  return { products: products.affectedRows, offers: offers.affectedRows };
}
