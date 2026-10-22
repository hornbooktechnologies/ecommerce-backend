import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as catalog from "../catalog/catalog.service.js";
import * as inventory from "../inventory/inventory.service.js";
import * as offers from "../offers/offers.service.js";
import * as defaultDao from "./bulk-operations.dao.js";
import { parseCsv, stringifyCsv } from "./csv.js";

const templateRows = {
  PRODUCT: [{ product_code: "TSHIRT-001", name: "Core cotton T-shirt", vertical: "CLOTHING", sku: "TSHIRT-001-BLK-M",
    variant_name: "Black / M", brand: "Loom & Lane", category: "Clothing", color: "Black", size: "M",
    barcode: "", base_uom: "EA", selling_uom: "EA", list_price: "1699", sale_price: "1499", cost_price: "800",
    short_description: "Everyday cotton crew-neck T-shirt", image_urls: "https://example.com/front.jpg|https://example.com/back.jpg" }],
  PRICING: [{ offer_id: "copy-from-export", seller_sku: "TSHIRT-001-BLK-M", list_price: "1699", sale_price: "1499", cost_price: "800", status: "ACTIVE" }],
  INVENTORY: [{ warehouse_code: "BLR-CENTRAL", offer_id: "copy-from-export", seller_sku: "TSHIRT-001-BLK-M",
    quantity: "20", unit_cost: "800", lot_number: "", manufactured_at: "", expires_at: "", serial_numbers: "",
    supplier_document_number: "INV-1001", notes: "Opening stock" }]
};
const headers = Object.fromEntries(Object.entries(templateRows).map(([type, rows]) => [type, Object.keys(rows[0])]));

function fail(code, message, status = 422, details = []) { throw new AppError({ code, message, status, details }); }
function fieldError(field, message) { return { field, code: "invalid", message }; }
function required(row, field, errors) { if (!String(row[field] || "").trim()) errors.push(fieldError(field, `${field.replaceAll("_", " ")} is required.`)); }
function decimal(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function bool(value) { return ["1", "true", "yes", "y"].includes(String(value || "").trim().toLowerCase()); }
function nullable(value) { return String(value || "").trim() || null; }
function named(list, value, keys = ["name", "code", "label", "value"]) {
  const search = String(value || "").trim().toLocaleLowerCase("en-IN");
  if (!search) return null;
  return list.find((item) => keys.some((key) => String(item[key] || "").toLocaleLowerCase("en-IN") === search)) || null;
}
function csvError(error) {
  if (error.message === "CSV_QUOTE_UNCLOSED") return "The CSV contains an unclosed quoted value.";
  if (error.message === "CSV_HEADERS_INVALID") return "CSV column names must be present and unique.";
  return "The CSV could not be parsed.";
}

function assertHeaders(type, actual) {
  const requiredHeaders = type === "PRODUCT"
    ? ["product_code", "name", "vertical", "sku", "base_uom", "selling_uom", "list_price", "sale_price"]
    : type === "PRICING" ? ["offer_id", "list_price", "sale_price"]
      : ["warehouse_code", "offer_id", "quantity"];
  const missing = requiredHeaders.filter((header) => !actual.includes(header));
  if (missing.length) fail("CSV_COLUMNS_MISSING", `Add the required columns: ${missing.join(", ")}.`, 422,
    missing.map((field) => fieldError(field, "This column is required.")));
}

export function createBulkOperationsService({ dao = defaultDao, transaction = withTransaction,
  catalogService = catalog, offersService = offers, inventoryService = inventory } = {}) {
  async function validationContext(tenantId, type) {
    if (type === "PRODUCT") {
      const [lookups, existing] = await Promise.all([catalogService.ensureDefaults(tenantId), dao.existingCatalogKeys({ tenantId })]);
      return { lookups, existing };
    }
    if (type === "PRICING") return { pricing: await dao.pricingContexts({ tenantId }) };
    return { inventory: await dao.inventoryContexts({ tenantId }) };
  }

  function normalizeProduct(row, context, fileKeys) {
    const errors = [];
    ["product_code", "name", "vertical", "sku", "base_uom", "selling_uom", "list_price", "sale_price"].forEach((field) => required(row, field, errors));
    const productCode = row.product_code.toUpperCase(); const sku = row.sku.toUpperCase(); const vertical = row.vertical.toUpperCase();
    if (context.existing.productCodes.has(productCode) || fileKeys.productCodes.has(productCode)) errors.push(fieldError("product_code", "Product code already exists."));
    if (context.existing.skus.has(sku) || fileKeys.skus.has(sku)) errors.push(fieldError("sku", "SKU already exists."));
    const type = context.lookups.productTypes.find((item) => item.vertical === vertical);
    if (!type) errors.push(fieldError("vertical", "This product type is not enabled for the tenant."));
    const baseUom = named(context.lookups.units, row.base_uom); const sellingUom = named(context.lookups.units, row.selling_uom);
    if (!baseUom) errors.push(fieldError("base_uom", "Use an active unit code."));
    if (!sellingUom) errors.push(fieldError("selling_uom", "Use an active unit code."));
    const brand = row.brand ? named(context.lookups.brands, row.brand) : null;
    const category = row.category ? named(context.lookups.categories, row.category) : null;
    const color = row.color ? named(context.lookups.colors, row.color) : null;
    const size = row.size ? named(context.lookups.sizes, row.size) : null;
    if (row.brand && !brand) errors.push(fieldError("brand", "Brand was not found in catalog masters."));
    if (row.category && !category) errors.push(fieldError("category", "Category was not found in catalog masters."));
    if (row.color && !color) errors.push(fieldError("color", "Color was not found in catalog masters."));
    if (row.size && !size) errors.push(fieldError("size", "Size was not found in catalog masters."));
    const listPrice = decimal(row.list_price); const salePrice = decimal(row.sale_price); const costInput = nullable(row.cost_price);
    const costPrice = costInput === null ? null : decimal(row.cost_price);
    if (!listPrice || listPrice <= 0) errors.push(fieldError("list_price", "MRP must be greater than zero."));
    if (!salePrice || salePrice <= 0 || (listPrice && salePrice > listPrice)) errors.push(fieldError("sale_price", "Selling price must be greater than zero and not exceed MRP."));
    if (costInput !== null && (costPrice === null || costPrice < 0)) errors.push(fieldError("cost_price", "Cost price must be zero or greater."));
    const imageUrls = String(row.image_urls || "").split("|").map((value) => value.trim()).filter(Boolean);
    for (const url of imageUrls) { try { const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); } catch { errors.push(fieldError("image_urls", `Invalid image URL: ${url}`)); } }
    if (imageUrls.length > 6) errors.push(fieldError("image_urls", "Add no more than six image URLs during product import."));
    if (!errors.length) { fileKeys.productCodes.add(productCode); fileKeys.skus.add(sku); }
    return { errors, normalized: errors.length ? null : {
      productCode, name: row.name, vertical, brandId: brand?.id || null, categoryId: category?.id || null,
      taxCategoryId: context.lookups.taxCategories[0]?.id || null, imageUrls, shortDescription: row.short_description || "",
      hsnSacCode: row.hsn_sac_code || "", countryOfOrigin: (row.country_of_origin || "IN").toUpperCase(),
      manufacturerName: row.manufacturer_name || "", ingredients: row.ingredients || "", storageInstructions: row.storage_instructions || "",
      allowSubstitutions: bool(row.allow_substitutions), modelNumber: row.model_number || "", gender: (row.gender || "").toUpperCase(),
      customFields: [], isReturnable: row.is_returnable === "" || row.is_returnable === undefined ? true : bool(row.is_returnable),
      returnWindowDays: decimal(row.return_window_days) ?? 7,
      variant: { sku, barcode: row.barcode || "", name: row.variant_name || "Standard", colorOptionId: color?.id || null,
        sizeOptionId: size?.id || null, material: row.material || "", baseUomId: baseUom.id, sellingUomId: sellingUom.id,
        packQuantity: decimal(row.pack_quantity) || 1, soldByWeight: bool(row.sold_by_weight), minimumOrderQuantity: decimal(row.minimum_order_quantity) || 1,
        maximumOrderQuantity: decimal(row.maximum_order_quantity), quantityStep: decimal(row.quantity_step) || 1,
        estimatedWeight: decimal(row.estimated_weight), minimumWeight: decimal(row.minimum_weight), maximumWeight: decimal(row.maximum_weight),
        weightStep: decimal(row.weight_step), warrantyMonths: decimal(row.warranty_months), warrantyType: nullable(row.warranty_type)?.toUpperCase() || null,
        pricing: { listPrice, salePrice, costPrice } }
    } };
  }

  function normalizePricing(row, context) {
    const errors = []; ["offer_id", "list_price", "sale_price"].forEach((field) => required(row, field, errors));
    const offer = context.pricing.find((item) => item.offerId === row.offer_id);
    if (!offer) errors.push(fieldError("offer_id", "Offer was not found in this tenant. Download a fresh pricing export."));
    const listPrice = decimal(row.list_price); const salePrice = decimal(row.sale_price);
    const costInput = nullable(row.cost_price); const costPrice = costInput === null ? null : decimal(row.cost_price);
    if (!listPrice || listPrice <= 0) errors.push(fieldError("list_price", "MRP must be greater than zero."));
    if (!salePrice || salePrice <= 0 || (listPrice && salePrice > listPrice)) errors.push(fieldError("sale_price", "Selling price must be greater than zero and not exceed MRP."));
    if (costInput !== null && (costPrice === null || costPrice < 0)) errors.push(fieldError("cost_price", "Cost price must be zero or greater."));
    const status = (row.status || offer?.status || "DRAFT").toUpperCase();
    if (!["DRAFT", "ACTIVE", "INACTIVE"].includes(status)) errors.push(fieldError("status", "Use DRAFT, ACTIVE, or INACTIVE."));
    return { errors, normalized: errors.length ? null : { offerId: offer.offerId, sellerSku: offer.sellerSku,
      listPrice, salePrice, costPrice, status, priceListId: offer.priceListId } };
  }

  function normalizeInventory(row, context) {
    const errors = []; ["warehouse_code", "offer_id", "quantity"].forEach((field) => required(row, field, errors));
    const match = context.inventory.find((item) => item.warehouseCode.toUpperCase() === row.warehouse_code.toUpperCase() && item.offerId === row.offer_id);
    if (!match) errors.push(fieldError("offer_id", "This offer is not supplied by the selected warehouse."));
    const quantity = decimal(row.quantity); const unitCostInput = nullable(row.unit_cost);
    const unitCost = unitCostInput === null ? null : decimal(row.unit_cost);
    if (!quantity || quantity <= 0) errors.push(fieldError("quantity", "Quantity must be greater than zero."));
    if (unitCostInput !== null && (unitCost === null || unitCost < 0)) errors.push(fieldError("unit_cost", "Unit cost must be zero or greater."));
    const serialNumbers = String(row.serial_numbers || "").split("|").map((value) => value.trim()).filter(Boolean);
    if (match?.lotTrackingEnabled && !row.lot_number) errors.push(fieldError("lot_number", "A lot number is required for this product."));
    if (match?.expiryTrackingEnabled && !row.expires_at) errors.push(fieldError("expires_at", "An expiry date is required for this product."));
    if (match?.serialTrackingEnabled && (!Number.isInteger(quantity) || serialNumbers.length !== quantity)) errors.push(fieldError("serial_numbers", "Provide one unique serial number per unit, separated by |."));
    if (!match?.serialTrackingEnabled && serialNumbers.length) errors.push(fieldError("serial_numbers", "This product is not serial tracked."));
    if (new Set(serialNumbers).size !== serialNumbers.length) errors.push(fieldError("serial_numbers", "Serial numbers must be unique."));
    return { errors, normalized: errors.length ? null : { warehouseId: match.warehouseId, offerId: match.offerId,
      purchaseOrderId: null, purchaseOrderItemId: null, quantity, unitCost, supplierDocumentNumber: row.supplier_document_number || "",
      notes: row.notes || "Bulk inventory import", lotNumber: row.lot_number || "", manufacturedAt: nullable(row.manufactured_at),
      expiresAt: nullable(row.expires_at), serialNumbers } };
  }

  async function validateImport(tenantId, type, input, context) {
    let parsed;
    try { parsed = parseCsv(input.csv); } catch (error) { fail("CSV_INVALID", csvError(error)); }
    assertHeaders(type, parsed.headers);
    if (!parsed.rows.length) fail("CSV_EMPTY", "The CSV has headers but no data rows.");
    if (parsed.rows.length > 5000) fail("CSV_TOO_LARGE", "A single import can contain at most 5,000 rows.", 413);
    const jobId = createId(); const validation = await validationContext(tenantId, type);
    const fileKeys = { productCodes: new Set(), skus: new Set() }; let valid = 0; let invalid = 0;
    await transaction(tenantId, async (connection) => {
      await dao.insertJob({ job: { id: jobId, tenantId, type, fileName: input.fileName, createdBy: context.actorUserId }, connection });
      for (const source of parsed.rows) {
        const result = type === "PRODUCT" ? normalizeProduct(source.data, validation, fileKeys)
          : type === "PRICING" ? normalizePricing(source.data, validation) : normalizeInventory(source.data, validation);
        if (result.errors.length) invalid += 1; else valid += 1;
        await dao.insertRow({ row: { id: createId(), tenantId, jobId, rowNumber: source.rowNumber, source: source.data,
          status: result.errors.length ? "INVALID" : "VALID", normalized: result.normalized, errors: result.errors }, connection });
      }
      await dao.finishValidation({ jobId, counts: { total: parsed.rows.length, valid, invalid }, connection });
    });
    return getJob(tenantId, jobId);
  }

  async function getJob(tenantId, jobId) {
    const job = await dao.findJob({ tenantId, jobId });
    if (!job) fail("IMPORT_JOB_NOT_FOUND", "Import job was not found.", 404);
    const rows = await dao.listRows({ tenantId, jobId });
    return { ...job, rows: rows.slice(0, 100) };
  }

  async function commitImport(tenantId, type, jobId, context) {
    const job = await dao.findJob({ tenantId, jobId });
    if (!job || job.type !== type) fail("IMPORT_JOB_NOT_FOUND", "Import job was not found.", 404);
    if (job.invalidRows) fail("IMPORT_HAS_ERRORS", "Resolve every validation error and upload the corrected CSV before committing.", 409);
    if (job.status !== "READY") fail("IMPORT_NOT_READY", "This import has already been committed or is not ready.", 409);
    if (!await dao.claimJob({ tenantId, jobId })) fail("IMPORT_NOT_READY", "Another request already started this import.", 409);
    const rows = await dao.listRows({ tenantId, jobId, status: "VALID" }); let committed = 0; let failed = 0;
    for (const row of rows) {
      try {
        if (type === "PRODUCT") await catalogService.createProduct(tenantId, row.normalized, context);
        else if (type === "PRICING") await offersService.updateOffer(tenantId, row.normalized.offerId, {
          listPrice: row.normalized.listPrice, salePrice: row.normalized.salePrice, costPrice: row.normalized.costPrice,
          status: row.normalized.status, priceListId: row.normalized.priceListId
        }, context);
        else await inventoryService.receiveStock(tenantId, row.normalized, context);
        await dao.markRow({ rowId: row.id, status: "COMMITTED" }); committed += 1;
      } catch (error) {
        await dao.markRow({ rowId: row.id, status: "FAILED", errors: [{ field: "row", code: error.code || "commit_failed",
          message: error.message || "The row could not be committed." }] }); failed += 1;
      }
    }
    await dao.finishCommit({ jobId, actorUserId: context.actorUserId, committed, failed });
    return getJob(tenantId, jobId);
  }

  async function exportFile(tenantId, type) {
    let rows;
    if (type === "PRODUCT") rows = (await dao.exportProducts({ tenantId })).map((row) => ({ ...row }));
    else if (type === "PRICING") rows = (await dao.exportPricing({ tenantId })).map((row) => ({
      offer_id: row.offerId, seller_sku: row.sellerSku, product_code: row.productCode, product_name: row.productName,
      variant_name: row.variantName, list_price: row.listPrice, sale_price: row.salePrice, cost_price: row.costPrice, status: row.status
    }));
    else rows = (await dao.exportInventory({ tenantId })).map((row) => ({ ...row }));
    const exportHeaders = rows.length ? Object.keys(rows[0]) : headers[type];
    return { filename: `${type.toLowerCase()}-export-${new Date().toISOString().slice(0, 10)}.csv`, csv: stringifyCsv(exportHeaders, rows) };
  }

  function template(type) { return { filename: `${type.toLowerCase()}-import-template.csv`, csv: stringifyCsv(headers[type], templateRows[type]) }; }
  async function errorReport(tenantId, jobId) {
    const job = await dao.findJob({ tenantId, jobId }); if (!job) fail("IMPORT_JOB_NOT_FOUND", "Import job was not found.", 404);
    const rows = (await dao.listRows({ tenantId, jobId })).filter((row) => row.errors.length).flatMap((row) => row.errors.map((error) => ({
      row_number: row.rowNumber, field: error.field, code: error.code, message: error.message, source_data: JSON.stringify(row.source)
    })));
    return { filename: `${job.type.toLowerCase()}-import-errors.csv`, csv: stringifyCsv(["row_number", "field", "code", "message", "source_data"], rows) };
  }

  async function bulkTransition(tenantId, productIds, action, context) {
    const results = [];
    for (const productId of productIds) {
      try { await catalogService.transitionProduct(tenantId, productId, action, context); results.push({ productId, status: "COMPLETED" }); }
      catch (error) { results.push({ productId, status: "FAILED", code: error.code || "TRANSITION_FAILED", message: error.message }); }
    }
    return { action, completed: results.filter((item) => item.status === "COMPLETED").length,
      failed: results.filter((item) => item.status === "FAILED").length, results };
  }

  return { listJobs: (tenantId, input) => dao.listJobs({ tenantId, ...input }), getJob, validateImport, commitImport,
    exportFile, template, errorReport, bulkTransition };
}

const service = createBulkOperationsService();
export const { listJobs, getJob, validateImport, commitImport, exportFile, template, errorReport, bulkTransition } = service;
