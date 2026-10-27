import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../../config/env.js";
import { closePrimaryPool, getPrimaryPool } from "../pool-factory.js";
import { findTenantOwner } from "../../modules/platform-tenants/platform-tenants.dao.js";
import {
  createMaster, createProduct, ensureDefaults, getProductVariants,
  listMasters, listProductMedia, transitionProduct, updateProductPrices,
  uploadProductMedia
} from "../../modules/catalog/catalog.service.js";
import { findBalance, listOptions as listInventoryOptions } from "../../modules/inventory/inventory.dao.js";
import { receiveStock } from "../../modules/inventory/inventory.service.js";
import { createPromotionsService } from "../../modules/promotions/promotions.service.js";
import { findHornbookRetailTenant, listAuraProducts, summarizeAuraImport } from "./seed-hornbook-storefront-catalog.dao.js";
import { storefrontCategories, storefrontProducts } from "./hornbook-storefront-catalog.fixtures.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendImageDirectory = path.resolve(scriptDirectory, "../../../../ecommerce-frontend/public/images");
const requiredVerticals = ["GENERAL", "GROCERY", "ELECTRONICS", "CLOTHING"];

function actorContext(actorUserId) {
  return {
    actorUserId, requestId: "seed-hornbook-storefront-catalog",
    ipAddress: "127.0.0.1", userAgent: "hornbook-storefront-catalog-seed"
  };
}

function normalize(value) {
  return String(value || "").trim().toLocaleLowerCase("en-IN");
}

function requiredItem(items, predicate, label) {
  const item = items.find(predicate);
  if (!item) throw new Error(`Required catalog value is missing: ${label}`);
  return item;
}

async function ensureMasterValues(tenantId, context) {
  const definitions = [
    ["categories", Object.keys(storefrontCategories)],
    ["brands", [...new Set(storefrontProducts.map((product) => product.brand))]]
  ];
  for (const [masterType, names] of definitions) {
    let existing = await listMasters(tenantId, masterType, { search: "", status: "ALL" });
    for (const name of names) {
      if (existing.some((item) => normalize(item.name) === normalize(name))) continue;
      await createMaster(tenantId, masterType, { name, parentId: null, swatchValue: "" }, context);
      existing = await listMasters(tenantId, masterType, { search: "", status: "ALL" });
    }
  }
}

function customFields(product, category) {
  return [
    { label: "Storefront badge", type: "TEXT", value: product.tag },
    { label: "Storefront rating", type: "NUMBER", value: product.rating },
    { label: "Storefront review count", type: "NUMBER", value: product.reviews },
    ...Object.entries(category.specs).map(([label, value]) => ({ label, type: "TEXT", value }))
  ];
}

function productInput(product, lookups) {
  const category = storefrontCategories[product.category];
  const unit = requiredItem(lookups.units, (item) => item.code === "EA", "EA unit");
  const categoryMaster = requiredItem(lookups.categories,
    (item) => normalize(item.name) === normalize(product.category), product.category);
  const brand = requiredItem(lookups.brands,
    (item) => normalize(item.name) === normalize(product.brand), product.brand);
  const taxCategory = requiredItem(lookups.taxCategories, () => true, "default GST category");
  const code = `AURA-${String(product.id).padStart(5, "0")}`;
  return {
    productCode: code, name: product.name, productKind: "STANDARD",
    vertical: category.vertical, brandId: brand.id, categoryId: categoryMaster.id,
    taxCategoryId: taxCategory.id, imageUrls: [], shortDescription: category.intro,
    hsnSacCode: category.hsnSacCode, countryOfOrigin: "IN", manufacturerName: product.brand,
    ingredients: category.vertical === "GROCERY" ? product.name : "",
    storageInstructions: category.vertical === "GROCERY"
      ? "Store in a cool, dry place and follow the pack label." : "",
    allowSubstitutions: category.vertical === "GROCERY",
    modelNumber: category.vertical === "ELECTRONICS" ? code : "",
    gender: category.vertical === "CLOTHING" ? "UNISEX" : "",
    customFields: customFields(product, category),
    isReturnable: category.vertical !== "GROCERY", returnWindowDays: category.returnWindowDays,
    variant: {
      sku: `${code}-STD`, barcode: "", name: "Standard",
      colorOptionId: null, sizeOptionId: null, material: "",
      baseUomId: unit.id, sellingUomId: unit.id, packQuantity: 1,
      soldByWeight: false, minimumOrderQuantity: 1, maximumOrderQuantity: null,
      quantityStep: 1, estimatedWeight: null, minimumWeight: null,
      maximumWeight: null, weightStep: null,
      warrantyMonths: category.vertical === "ELECTRONICS" ? 12 : null,
      warrantyType: category.vertical === "ELECTRONICS" ? "MANUFACTURER" : null,
      pricing: { listPrice: product.mrp, salePrice: product.price,
        costPrice: Number((product.price * 0.62).toFixed(2)) }
    }
  };
}

async function ensurePublished(tenantId, productId, context) {
  for (let step = 0; step < 3; step += 1) {
    const product = (await listAuraProducts({ tenantId })).find((item) => item.id === productId);
    if (!product || product.publicationStatus === "PUBLISHED" || product.publicationStatus === "ARCHIVED") return;
    if (["DRAFT", "REJECTED"].includes(product.approvalStatus)) {
      await transitionProduct(tenantId, productId, "submit", context);
    } else if (product.approvalStatus === "PENDING") {
      await transitionProduct(tenantId, productId, "approve", context,
        { note: "Approved storefront catalog import." });
    } else if (product.approvalStatus === "APPROVED") {
      await transitionProduct(tenantId, productId, "publish", context,
        { note: "Published storefront catalog import." });
    }
  }
}

async function ensurePrice(tenantId, productId, sourceProduct, context) {
  const details = await getProductVariants(tenantId, productId);
  const missing = details.variants.filter((variant) => variant.salePrice === null);
  if (!missing.length) return false;
  await updateProductPrices(tenantId, productId, {
    prices: missing.map((variant) => ({
      variantId: variant.id, listPrice: sourceProduct.mrp, salePrice: sourceProduct.price,
      costPrice: Number((sourceProduct.price * 0.62).toFixed(2))
    }))
  }, context);
  return true;
}

async function ensureImage(tenantId, productId, sourceProduct, context) {
  const current = await listProductMedia(tenantId, productId);
  if (current.items.length) return false;
  const originalName = `${sourceProduct.image}.webp`;
  const buffer = await readFile(path.join(frontendImageDirectory, originalName));
  await uploadProductMedia(tenantId, productId, {
    altText: `${sourceProduct.name} product image`, variantId: null, colorOptionId: null
  }, { buffer, mimeType: "image/webp", originalName }, context);
  return true;
}

function stockQuantity(vertical) {
  if (vertical === "GROCERY") return 30;
  if (vertical === "ELECTRONICS") return 8;
  if (vertical === "CLOTHING") return 18;
  return 20;
}

function dateOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateTimeOffset(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

async function ensureAuraPromotion(tenantId, context) {
  const service = createPromotionsService();
  const name = "AURA Storefront 10%";
  const directory = await service.listPromotions(tenantId,
    { search: name, status: "ALL", type: "ALL", page: 1, pageSize: 100 });
  let promotion = directory.items.find((item) => item.name === name);
  let promotionCreated = false;
  let couponCreated = false;
  if (!promotion) {
    const result = await service.createPromotion(tenantId, {
      name, type: "PERCENTAGE", discountValue: 10, maxDiscountAmount: 500,
      minimumOrderAmount: 0, couponRequired: true, stackable: false, priority: 90,
      usageLimitTotal: 10000, usageLimitPerCustomer: 1, storeId: null,
      startsAt: dateTimeOffset(-1), endsAt: dateTimeOffset(365)
    }, context);
    promotion = result.promotion;
    promotionCreated = true;
  }
  let details = await service.getPromotion(tenantId, promotion.id);
  if (!details.coupons.some((coupon) => coupon.code === "AURA10")) {
    details = await service.createCoupon(tenantId, promotion.id, {
      code: "AURA10", usageLimit: 10000, status: "ACTIVE",
      startsAt: dateTimeOffset(-1), endsAt: dateTimeOffset(365)
    }, context);
    couponCreated = true;
  }
  if (details.promotion.storedStatus !== "ACTIVE") {
    await service.transitionPromotion(tenantId, promotion.id, "ACTIVE", context);
  }
  return { name, coupon: "AURA10", promotionCreated, couponCreated };
}

async function ensureInventory(tenantId, sourceBySku, context) {
  const pool = getPrimaryPool();
  const options = await listInventoryOptions({ tenantId });
  const warehouse = options.warehouses.find((item) => item.code === "BLR-CENTRAL") || options.warehouses[0];
  if (!warehouse) throw new Error("Hornbook Retail needs an active warehouse before storefront stock can be imported.");
  let received = 0;
  for (const offer of options.offers.filter((item) => sourceBySku.has(item.sku))) {
    const existing = await findBalance({ tenantId, warehouseId: warehouse.id,
      offerId: offer.id, connection: pool });
    if (existing) continue;
    const source = sourceBySku.get(offer.sku);
    const quantity = stockQuantity(offer.vertical);
    const trackedLot = offer.lotTrackingEnabled;
    const trackedSerial = offer.serialTrackingEnabled;
    await receiveStock(tenantId, {
      warehouseId: warehouse.id, offerId: offer.id, quantity,
      purchaseOrderId: null, purchaseOrderItemId: null,
      supplierDocumentNumber: `AURA-DEMO-${String(source.id).padStart(5, "0")}`,
      notes: "Initial stock imported from the AURA storefront demo catalog.",
      lotNumber: trackedLot ? `AURA-LOT-${String(source.id).padStart(5, "0")}` : "",
      manufacturedAt: trackedLot ? dateOffset(-7) : null,
      expiresAt: offer.expiryTrackingEnabled ? dateOffset(120) : null,
      unitCost: Number((source.price * 0.62).toFixed(2)),
      serialNumbers: trackedSerial
        ? Array.from({ length: quantity }, (_, index) => `${offer.sku}-${String(index + 1).padStart(3, "0")}`)
        : []
    }, context);
    received += 1;
  }
  return { warehouse: warehouse.name, received };
}

async function main() {
  if (env.nodeEnv === "production") {
    throw new Error("The Hornbook storefront demo catalog cannot be seeded in production.");
  }
  const tenant = await findHornbookRetailTenant();
  if (!tenant) throw new Error('Active tenant "Hornbook Retail" was not found. No data was changed.');
  const owner = await findTenantOwner({ tenantId: tenant.id });
  if (!owner) throw new Error("Hornbook Retail has no active owner for audit attribution.");
  const context = actorContext(owner.id);

  let lookups = await ensureDefaults(tenant.id);
  const enabledVerticals = new Set(lookups.productTypes.map((item) => item.vertical));
  const missingVerticals = requiredVerticals.filter((vertical) => !enabledVerticals.has(vertical));
  if (missingVerticals.length) {
    throw new Error(`Hornbook Retail is missing required product types: ${missingVerticals.join(", ")}. No products were imported.`);
  }
  await ensureMasterValues(tenant.id, context);
  lookups = await ensureDefaults(tenant.id);

  const existingRows = await listAuraProducts({ tenantId: tenant.id });
  const existingByCode = new Map(existingRows.map((item) => [item.productCode, item]));
  const created = [];
  const skipped = [];
  let priced = 0;
  let images = 0;

  for (const sourceProduct of storefrontProducts) {
    const input = productInput(sourceProduct, lookups);
    let record = existingByCode.get(input.productCode);
    if (!record) {
      const result = await createProduct(tenant.id, input, context);
      record = { id: result.id, productCode: result.productCode };
      existingByCode.set(input.productCode, record);
      created.push(input.productCode);
    } else {
      skipped.push(input.productCode);
    }
    if (await ensurePrice(tenant.id, record.id, sourceProduct, context)) priced += 1;
    if (await ensureImage(tenant.id, record.id, sourceProduct, context)) images += 1;
    await ensurePublished(tenant.id, record.id, context);
  }

  const sourceBySku = new Map(storefrontProducts.map((product) => [
    `AURA-${String(product.id).padStart(5, "0")}-STD`, product
  ]));
  const inventory = await ensureInventory(tenant.id, sourceBySku, context);
  const promotion = await ensureAuraPromotion(tenant.id, context);
  const summary = await summarizeAuraImport({ tenantId: tenant.id });
  process.stdout.write(`${JSON.stringify({
    tenant: { id: tenant.id, code: tenant.code, name: tenant.name },
    created: created.length, alreadyPresent: skipped.length,
    pricesAdded: priced, imagesUploaded: images,
    stockBalancesCreated: inventory.received, warehouse: inventory.warehouse,
    promotion,
    summary
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(closePrimaryPool);
