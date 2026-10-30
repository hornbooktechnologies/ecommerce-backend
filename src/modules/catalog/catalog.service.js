import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./catalog.dao.js";
import { productMediaStorage as defaultMediaStorage } from "./product-media-storage.js";

const typeTemplates = [
  { code: "GENERAL", name: "General merchandise", vertical: "GENERAL" },
  { code: "GROCERY", name: "Grocery & fresh", vertical: "GROCERY", lotTracking: true, expiryTracking: true, variableWeight: true },
  { code: "ELECTRONICS", name: "Electronics", vertical: "ELECTRONICS", serialTracking: true, warranty: true },
  { code: "CLOTHING", name: "Clothing & apparel", vertical: "CLOTHING" }
];

const unitTemplates = [
  { code: "EA", name: "Each", dimension: "COUNT", decimalScale: 0 },
  { code: "KG", name: "Kilogram", dimension: "WEIGHT", decimalScale: 3 },
  { code: "G", name: "Gram", dimension: "WEIGHT", decimalScale: 0 },
  { code: "L", name: "Litre", dimension: "VOLUME", decimalScale: 3 },
  { code: "ML", name: "Millilitre", dimension: "VOLUME", decimalScale: 0 }
];

const categoryTemplates = ["Grocery", "Electronics", "Clothing", "Home & living"];
const colorTemplates = [
  { name: "Black", swatchValue: "#17191d" }, { name: "White", swatchValue: "#ffffff" },
  { name: "Blue", swatchValue: "#2563eb" }, { name: "Green", swatchValue: "#1f6d52" },
  { name: "Red", swatchValue: "#dc3f3f" }
];
const sizeTemplates = ["XS", "S", "M", "L", "XL"];

function appError(code, message, status, details = []) {
  return new AppError({ code, message, status, details });
}

function slug(value) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 260);
}

function customFieldCode(label) {
  const suffix = label.toUpperCase().normalize("NFKD")
    .replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 73);
  return `CUSTOM_${suffix || "FIELD"}`;
}

function productMetadata(vertical, input) {
  return {
    vertical,
    ...(vertical === "GROCERY" ? { grocery: {
      ingredients: input.ingredients || null,
      storageInstructions: input.storageInstructions || null,
      allowSubstitutions: input.allowSubstitutions
    } } : {}),
    ...(vertical === "ELECTRONICS" ? { electronics: {
      modelNumber: input.modelNumber || null
    } } : {}),
    ...(vertical === "CLOTHING" ? { clothing: {
      gender: input.gender || null
    } } : {})
  };
}

export function createCatalogService({ dao = defaultDao, transaction = withTransaction,
  mediaStorage = defaultMediaStorage } = {}) {
  async function replaceCustomFields({ tenantId, productId, productTypeId, fields, connection }) {
    const codes = fields.map((field) => customFieldCode(field.label));
    if (new Set(codes).size !== codes.length) {
      throw appError("DUPLICATE_CUSTOM_FIELD", "Custom field names must be unique.", 422,
        [{ field: "customFields", code: "duplicate", message: "Use a unique name for every custom field." }]);
    }

    await dao.clearProductCustomFields({ tenantId, productId, connection });
    for (const [index, field] of fields.entries()) {
      const code = codes[index];
      let attribute = await dao.findCustomAttributeDefinition({ tenantId, code, connection });
      if (attribute && attribute.dataType !== field.type) {
        throw appError("CUSTOM_FIELD_TYPE_MISMATCH",
          `${attribute.name} already exists as a ${attribute.dataType.toLowerCase()} field.`, 422,
          [{ field: `customFields.${index}.type`, code: "type_conflict",
            message: `Choose ${attribute.dataType.toLowerCase()} or use a different field name.` }]);
      }
      if (!attribute) {
        attribute = { id: createId(), name: field.label, dataType: field.type };
        await dao.insertAttributeDefinition({ attribute: {
          ...attribute, tenantId, code, isVariantAxis: false,
          isFilterable: false, isSearchable: false,
          validationRules: { source: "CUSTOM_PRODUCT_FIELD" }
        }, connection });
      }
      await dao.linkProductTypeAttribute({
        productTypeId, attributeId: attribute.id, group: "Custom specifications",
        sortOrder: 100 + index, connection
      });
      await dao.insertProductAttributeValue({ field: {
        id: createId(), tenantId, productId, attributeId: attribute.id,
        type: field.type, value: field.value
      }, connection });
    }
  }

  async function ensureDefaults(tenantId) {
    return transaction(tenantId, async (connection) => {
      const enabledVerticals = await dao.listEnabledVerticals({ tenantId, connection });
      if (!enabledVerticals.length) {
        throw appError("CATALOG_VERTICALS_NOT_CONFIGURED",
          "No product types are configured for this tenant. Contact the platform administrator.", 409);
      }
      let lookups = await dao.listLookups({ tenantId, connection });
      const [allCategories, allColors, allSizes] = await Promise.all([
        dao.listMasters({ tenantId, masterType: "categories", search: "", status: "ALL", connection }),
        dao.listMasters({ tenantId, masterType: "colors", search: "", status: "ALL", connection }),
        dao.listMasters({ tenantId, masterType: "sizes", search: "", status: "ALL", connection })
      ]);
      const typeCodes = new Set(lookups.productTypes.map((item) => item.code));
      const unitCodes = new Set(lookups.units.map((item) => item.code));
      for (const template of typeTemplates.filter((item) => enabledVerticals.includes(item.vertical))) {
        if (!typeCodes.has(template.code)) await dao.insertProductType({ type: {
          id: createId(), tenantId, lotTracking: false, serialTracking: false,
          expiryTracking: false, warranty: false, variableWeight: false, ...template
        }, connection });
      }
      for (const template of unitTemplates) {
        if (!unitCodes.has(template.code)) await dao.insertUnit({ unit: { id: createId(), tenantId, ...template }, connection });
      }
      if (!lookups.taxCategories.length) {
        await dao.insertTaxCategory({ taxCategory: { id: createId(), tenantId }, connection });
      }
      if (!allCategories.length) {
        for (const [sortOrder, name] of categoryTemplates.entries()) {
          await dao.insertCategory({ category: {
            id: createId(), tenantId, name, slug: slug(name), sortOrder
          }, connection });
        }
      }
      for (const attributeTemplate of [
        { code: "COLOR", name: "Color", items: colorTemplates, isVariantAxis: true },
        { code: "SIZE", name: "Size", items: sizeTemplates.map((name) => ({ name })), isVariantAxis: true }
      ]) {
        let attribute = await dao.findAttributeDefinition({ tenantId, code: attributeTemplate.code, connection });
        if (!attribute) {
          attribute = { id: createId() };
          await dao.insertAttributeDefinition({ attribute: { ...attribute, tenantId,
            code: attributeTemplate.code, name: attributeTemplate.name,
            isVariantAxis: attributeTemplate.isVariantAxis }, connection });
        }
        const existing = attributeTemplate.code === "COLOR" ? allColors : allSizes;
        if (!existing.length) {
          for (const [sortOrder, item] of attributeTemplate.items.entries()) {
            await dao.insertAttributeOption({ option: { id: createId(), tenantId,
              attributeId: attribute.id, value: item.name.toLowerCase(), label: item.name,
              swatchValue: item.swatchValue, sortOrder }, connection });
          }
        }
      }
      const commerceScope = await dao.findDefaultCommerceScope({ tenantId, connection });
      let priceList = await dao.findDefaultPriceList({ tenantId, connection });
      if (commerceScope && !priceList) {
        await dao.insertPriceList({ priceList: {
          id: createId(), tenantId, currency: commerceScope.currency || "INR"
        }, connection });
        priceList = await dao.findDefaultPriceList({ tenantId, connection });
      }
      lookups = await dao.listLookups({ tenantId, connection });
      return {
        ...lookups,
        pricingContext: commerceScope && priceList ? {
          storeId: commerceScope.storeId,
          storeName: commerceScope.storeName,
          merchantId: commerceScope.merchantId,
          merchantName: commerceScope.merchantName,
          priceListId: priceList.id,
          priceListName: priceList.name,
          currency: priceList.currency,
          includesTax: priceList.includesTax
        } : null
      };
    });
  }

  async function createProduct(tenantId, input, context) {
    const productId = createId();
    await ensureDefaults(tenantId);
    try {
      await transaction(tenantId, async (connection) => {
        const lookups = await dao.listLookups({ tenantId, connection });
        const productType = await dao.findEnabledProductType({
          tenantId, vertical: input.vertical, connection, forUpdate: true
        });
        if (!productType) throw appError("PRODUCT_TYPE_NOT_ENABLED",
          `${input.vertical.toLowerCase().replace(/^./, (letter) => letter.toUpperCase())} is not enabled for this tenant.`, 422,
          [{ field: "vertical", code: "not_enabled", message: "Select a product type enabled for this tenant." }]);
        const variants = input.variants?.length ? input.variants : [input.variant];
        const tenantReferences = [
          ["brandId", input.brandId, lookups.brands],
          ["categoryId", input.categoryId, lookups.categories],
          ["taxCategoryId", input.taxCategoryId, lookups.taxCategories]
        ];
        for (const [field, id, choices] of tenantReferences) {
          if (id && !choices.some((item) => item.id === id)) {
            throw appError("INVALID_CATALOG_REFERENCE", "Select catalog values from the active tenant.", 422,
              [{ field, code: "tenant_scope", message: "This value does not belong to the active tenant." }]);
          }
        }
        const combinations = new Set();
        for (const [index, variant] of variants.entries()) {
          if (!lookups.units.some((item) => item.id === variant.baseUomId)
            || !lookups.units.some((item) => item.id === variant.sellingUomId)) {
            throw appError("INVALID_UNIT", "Select units from the active tenant catalog.", 422,
              [{ field: `variants.${index}.sellingUomId`, code: "tenant_scope", message: "Select an active unit." }]);
          }
          for (const [field, id, choices] of [
            [`variants.${index}.colorOptionId`, variant.colorOptionId, lookups.colors],
            [`variants.${index}.sizeOptionId`, variant.sizeOptionId, lookups.sizes]
          ]) {
            if (id && !choices.some((item) => item.id === id)) {
              throw appError("INVALID_CATALOG_REFERENCE", "Select catalog values from the active tenant.", 422,
                [{ field, code: "tenant_scope", message: "This value does not belong to the active tenant." }]);
            }
          }
          const combination = `${variant.colorOptionId || "none"}:${variant.sizeOptionId || "none"}`;
          if (combinations.has(combination)) {
            throw appError("DUPLICATE_VARIANT_COMBINATION", "Each color and size combination can be used only once.", 422,
              [{ field: `variants.${index}`, code: "duplicate", message: "Choose a unique color and size combination." }]);
          }
          combinations.add(combination);
          if (variant.pricing && variant.pricing.salePrice > variant.pricing.listPrice) {
            throw appError("INVALID_VARIANT_PRICE", "Selling price cannot be greater than MRP.", 422,
              [{ field: `variants.${index}.pricing.salePrice`, code: "maximum", message: "Enter a selling price at or below MRP." }]);
          }
          if (input.vertical === "GROCERY" && variant.soldByWeight && !variant.weightStep) {
            throw appError("WEIGHT_STEP_REQUIRED", "Variable-weight products require a weight step.", 422,
              [{ field: `variants.${index}.weightStep`, code: "required", message: "Enter the smallest sellable weight increment." }]);
          }
          if (input.vertical === "ELECTRONICS" && variant.warrantyMonths && !variant.warrantyType) {
            throw appError("WARRANTY_TYPE_REQUIRED", "Select who provides the warranty.", 422);
          }
        }
        const commerceScope = await dao.findDefaultCommerceScope({ tenantId, connection });
        const priceList = await dao.findDefaultPriceList({ tenantId, connection });
        if (!commerceScope || !priceList) {
          throw appError("CATALOG_COMMERCE_SCOPE_MISSING",
            "A default store, first-party merchant, and price list are required before products can be priced.", 409);
        }
        const product = {
          id: productId, tenantId, productTypeId: productType.id, brandId: input.brandId,
          taxCategoryId: input.taxCategoryId, productCode: input.productCode, name: input.name,
          productKind: input.productKind,
          slug: `${slug(input.name)}-${input.productCode.toLowerCase()}`, shortDescription: input.shortDescription,
          hsnSacCode: input.hsnSacCode, countryOfOrigin: input.countryOfOrigin,
          manufacturerName: input.manufacturerName,
          isReturnable: input.isReturnable, returnWindowDays: input.isReturnable ? input.returnWindowDays : null,
          metadata: productMetadata(input.vertical, input)
        };
        await dao.insertProduct({ product, connection });
        if (input.categoryId) await dao.linkProductCategory({ productId, categoryId: input.categoryId, connection });
        await replaceCustomFields({ tenantId, productId, productTypeId: productType.id,
          fields: input.customFields, connection });
        let materialAttribute = null;
        for (const variant of variants) {
          const variantId = createId();
          await dao.insertVariant({ variant: { id: variantId, tenantId, productId, ...variant,
            weightUomId: variant.soldByWeight ? variant.sellingUomId : null }, connection });
          const selectedOptions = [
            { item: lookups.colors.find((entry) => entry.id === variant.colorOptionId), sortOrder: 0 },
            { item: lookups.sizes.find((entry) => entry.id === variant.sizeOptionId), sortOrder: 1 }
          ];
          for (const selection of selectedOptions) {
            if (!selection.item) continue;
            await dao.linkProductTypeAttribute({ productTypeId: productType.id,
              attributeId: selection.item.attributeId, sortOrder: selection.sortOrder, connection });
            await dao.insertVariantAttributeValue({ value: {
              id: createId(), tenantId, variantId, attributeId: selection.item.attributeId,
              optionId: selection.item.id
            }, connection });
          }
          if (variant.material) {
            materialAttribute ||= await dao.findAttributeDefinition({ tenantId, code: "MATERIAL", connection });
            if (!materialAttribute) {
              materialAttribute = { id: createId() };
              await dao.insertAttributeDefinition({ attribute: { ...materialAttribute, tenantId,
                code: "MATERIAL", name: "Material", isVariantAxis: false }, connection });
            }
            await dao.linkProductTypeAttribute({ productTypeId: productType.id,
              attributeId: materialAttribute.id, sortOrder: 2, connection });
            let option = await dao.findAttributeOption({ attributeId: materialAttribute.id,
              value: variant.material, connection });
            if (!option) {
              option = { id: createId() };
              await dao.insertAttributeOption({ option: { ...option, tenantId,
                attributeId: materialAttribute.id, value: variant.material.toLowerCase(),
                label: variant.material }, connection });
            }
            await dao.insertVariantAttributeValue({ value: { id: createId(), tenantId,
              variantId, attributeId: materialAttribute.id, optionId: option.id }, connection });
          }
          const offerId = createId();
          await dao.insertSellerOffer({ offer: {
            id: offerId, tenantId, storeId: commerceScope.storeId, merchantId: commerceScope.merchantId,
            variantId, sellerSku: variant.sku, taxCategoryId: input.taxCategoryId
          }, connection });
          if (variant.pricing) {
            await dao.insertOfferPrice({ price: {
              id: createId(), tenantId, offerId, priceListId: priceList.id,
              listPrice: variant.pricing.listPrice, salePrice: variant.pricing.salePrice,
              costPrice: variant.pricing.costPrice
            }, connection });
          }
        }

        for (const [sortOrder, fileKey] of input.imageUrls.entries()) {
          let asset = await dao.findMediaAssetByKey({ tenantId, fileKey, connection });
          if (!asset) {
            asset = { id: createId() };
            const pathname = new URL(fileKey).pathname;
            await dao.insertMediaAsset({ asset: {
              ...asset, tenantId, fileKey,
              originalName: pathname.split("/").filter(Boolean).pop() || `product-image-${sortOrder + 1}`,
              altText: input.name, createdBy: context.actorUserId
            }, connection });
          } else if (asset.deleted) await dao.restoreMediaAsset({ assetId: asset.id, altText: input.name, connection });
          await dao.linkProductMedia({ media: {
            id: createId(), productId, assetId: asset.id,
            role: sortOrder === 0 ? "PRIMARY" : "GALLERY", sortOrder
          }, connection });
        }
        const event = { id: createId(), tenantId, aggregateId: productId, type: "catalog.product.created",
          payload: { tenantId, productId, productCode: product.productCode, vertical: input.vertical } };
        await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
          action: event.type, entityId: productId, requestId: context.requestId,
          ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null,
          afterData: event.payload }, connection });
        await dao.insertOutbox({ event, connection });
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        throw appError("DUPLICATE_PRODUCT", "The product code, SKU, barcode, or slug is already in use.", 409);
      }
      throw error;
    }
    return { id: productId, productCode: input.productCode, name: input.name, productKind: input.productKind,
      variantCount: input.variants?.length || 1, customFieldCount: input.customFields.length,
      status: "DRAFT" };
  }

  async function masterResult(tenantId, masterType, itemId) {
    const items = await dao.listMasters({ tenantId, masterType, search: "", status: "ALL" });
    return items.find((item) => item.id === itemId) || null;
  }

  async function writeMasterRecords({ tenantId, itemId, masterType, action, context, afterData, connection }) {
    const eventType = `catalog.master.${action}`;
    await dao.insertAudit({ audit: { id: createId(), tenantId,
      actorUserId: context.actorUserId, action: eventType, entityType: "CATALOG_MASTER",
      entityId: itemId, requestId: context.requestId, ipAddress: context.ipAddress || null,
      userAgent: context.userAgent?.slice(0, 500) || null,
      afterData: { masterType, ...afterData } }, connection });
    await dao.insertOutbox({ event: { id: createId(), tenantId,
      aggregateType: "CATALOG_MASTER", aggregateId: itemId, type: eventType,
      payload: { tenantId, itemId, masterType, ...afterData } }, connection });
  }

  async function listMasters(tenantId, masterType, input) {
    await ensureDefaults(tenantId);
    return dao.listMasters({ tenantId, masterType, ...input });
  }

  async function createMaster(tenantId, masterType, input, context) {
    await ensureDefaults(tenantId);
    const itemId = createId();
    try {
      await transaction(tenantId, async (connection) => {
        if (masterType === "brands") {
          if (await dao.findBrandByName({ tenantId, name: input.name, connection })) {
            throw appError("MASTER_VALUE_EXISTS", "That brand already exists.", 409);
          }
          await dao.insertBrand({ brand: { id: itemId, tenantId,
            name: input.name, slug: slug(input.name) }, connection });
        } else if (masterType === "categories") {
          if (await dao.findCategoryByName({ tenantId, name: input.name, connection })) {
            throw appError("MASTER_VALUE_EXISTS", "That category already exists.", 409);
          }
          const parent = input.parentId
            ? await dao.findCategoryById({ tenantId, categoryId: input.parentId, connection }) : null;
          if (input.parentId && !parent) throw appError("INVALID_PARENT_CATEGORY", "Select a parent category from this tenant.", 422);
          const itemSlug = slug(input.name);
          await dao.insertCategory({ category: { id: itemId, tenantId, parentId: parent?.id || null,
            name: input.name, slug: itemSlug,
            path: parent ? `${parent.path}/${itemSlug}` : `/${itemSlug}`,
            depth: parent ? Number(parent.depth) + 1 : 0, sortOrder: 100 }, connection });
        } else {
          const code = masterType === "colors" ? "COLOR" : "SIZE";
          let attribute = await dao.findAttributeDefinition({ tenantId, code, connection });
          if (!attribute) {
            attribute = { id: createId() };
            await dao.insertAttributeDefinition({ attribute: { ...attribute, tenantId, code,
              name: masterType === "colors" ? "Color" : "Size", isVariantAxis: true }, connection });
          }
          if (await dao.findAttributeOption({ attributeId: attribute.id, value: input.name, connection })) {
            throw appError("MASTER_VALUE_EXISTS", `That ${masterType.slice(0, -1)} already exists.`, 409);
          }
          await dao.insertAttributeOption({ option: { id: itemId, tenantId,
            attributeId: attribute.id, value: input.name.toLowerCase(), label: input.name,
            swatchValue: masterType === "colors" ? input.swatchValue : null }, connection });
        }
        await writeMasterRecords({ tenantId, itemId, masterType, action: "created", context,
          afterData: { name: input.name }, connection });
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") throw appError("MASTER_VALUE_EXISTS", "That master value already exists.", 409);
      throw error;
    }
    return masterResult(tenantId, masterType, itemId);
  }

  async function updateMaster(tenantId, masterType, itemId, input, context) {
    await ensureDefaults(tenantId);
    try {
      await transaction(tenantId, async (connection) => {
        const changes = { ...input, ...(input.name ? { slug: slug(input.name), value: input.name.toLowerCase() } : {}) };
        if (input.name && masterType === "brands") {
          const duplicate = await dao.findBrandByName({ tenantId, name: input.name, connection });
          if (duplicate && duplicate.id !== itemId) throw appError("MASTER_VALUE_EXISTS", "That brand already exists.", 409);
        }
        if (input.name && masterType === "categories") {
          const duplicate = await dao.findCategoryByName({ tenantId, name: input.name, connection });
          if (duplicate && duplicate.id !== itemId) throw appError("MASTER_VALUE_EXISTS", "That category already exists.", 409);
        }
        const affected = masterType === "brands"
          ? await dao.updateBrandMaster({ tenantId, itemId, changes, connection })
          : masterType === "categories"
            ? await dao.updateCategoryMaster({ tenantId, itemId, changes, connection })
            : await dao.updateAttributeOptionMaster({ tenantId, itemId,
              changes: masterType === "sizes" ? { name: changes.name, value: changes.value, status: changes.status } : changes,
              connection });
        if (!affected) throw appError("MASTER_VALUE_NOT_FOUND", "The catalog master value could not be found.", 404);
        await writeMasterRecords({ tenantId, itemId, masterType, action: "updated", context,
          afterData: input, connection });
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") throw appError("MASTER_VALUE_EXISTS", "That master value already exists.", 409);
      throw error;
    }
    return masterResult(tenantId, masterType, itemId);
  }

  async function listProducts(tenantId, input) {
    const [result, summary] = await Promise.all([
      dao.listProducts({ tenantId, ...input }), dao.summarizeProducts({ tenantId })
    ]);
    return { ...result, page: input.page, pageSize: input.pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / input.pageSize)), summary };
  }

  async function getProductVariants(tenantId, productId) {
    await ensureDefaults(tenantId);
    const product = await dao.findProductDetail({ tenantId, productId });
    if (!product) throw appError("PRODUCT_NOT_FOUND", "The product could not be found.", 404);
    const commerceScope = await dao.findDefaultCommerceScope({ tenantId });
    const priceList = await dao.findDefaultPriceList({ tenantId });
    if (!commerceScope || !priceList) {
      throw appError("CATALOG_COMMERCE_SCOPE_MISSING",
        "A default store, first-party merchant, and price list are required before products can be priced.", 409);
    }
    const variants = await dao.listProductVariants({ tenantId, productId,
      storeId: commerceScope.storeId, merchantId: commerceScope.merchantId,
      priceListId: priceList.id });
    const [imageUrls, customFields] = await Promise.all([
      dao.listProductImages({ productId }), dao.listProductCustomFields({ tenantId, productId })
    ]);
    return {
      product: { ...product, imageUrls, customFields },
      scope: {
        storeId: commerceScope.storeId, storeName: commerceScope.storeName,
        merchantId: commerceScope.merchantId, merchantName: commerceScope.merchantName,
        priceListId: priceList.id, priceListName: priceList.name,
        currency: priceList.currency, includesTax: priceList.includesTax
      },
      variants
    };
  }

  async function updateProduct(tenantId, productId, input, context) {
    await ensureDefaults(tenantId);
    const orphanedMediaUrls = [];
    try {
      await transaction(tenantId, async (connection) => {
        const current = await dao.findProductDetail({ tenantId, productId, connection, forUpdate: true });
        if (!current) throw appError("PRODUCT_NOT_FOUND", "The product could not be found.", 404);
        const published = current.publicationStatus === "PUBLISHED" && current.approvalStatus === "APPROVED";
        if (!published && (current.publicationStatus === "PUBLISHED"
          || ["PENDING", "APPROVED"].includes(current.approvalStatus))) {
          throw appError("PRODUCT_EDIT_NOT_ALLOWED",
            "Products awaiting approval or publication cannot be edited. Publish an approved product or request changes first.", 409);
        }
        if (published && (!input.categoryId || !input.taxCategoryId || !input.hsnSacCode?.trim())) {
          throw appError("PRODUCT_NOT_READY",
            "Published products must keep a category, GST category and HSN code.", 422);
        }
        const lookups = await dao.listLookups({ tenantId, connection });
        for (const [field, id, choices] of [
          ["brandId", input.brandId, lookups.brands],
          ["categoryId", input.categoryId, lookups.categories],
          ["taxCategoryId", input.taxCategoryId, lookups.taxCategories]
        ]) {
          if (id && !choices.some((item) => item.id === id)) {
            throw appError("INVALID_CATALOG_REFERENCE", "Select catalog values from the active tenant.", 422,
              [{ field, code: "tenant_scope", message: "This value does not belong to the active tenant." }]);
          }
        }
        await dao.updateProduct({ product: {
          id: productId, tenantId, brandId: input.brandId, taxCategoryId: input.taxCategoryId,
          name: input.name, slug: current.slug || `${slug(input.name)}-${current.productCode.toLowerCase()}`,
          shortDescription: input.shortDescription, hsnSacCode: input.hsnSacCode,
          countryOfOrigin: input.countryOfOrigin, manufacturerName: input.manufacturerName,
          isReturnable: input.isReturnable,
          returnWindowDays: input.isReturnable ? input.returnWindowDays : null,
          metadata: productMetadata(current.vertical, input)
        }, connection });
        await dao.replaceProductCategory({ productId, categoryId: input.categoryId, connection });
        if (input.customFields !== undefined) {
          const productType = lookups.productTypes.find((item) => item.vertical === current.vertical);
          if (!productType) throw appError("CATALOG_SETUP_REQUIRED", "The product type is not available.", 409);
          await replaceCustomFields({ tenantId, productId, productTypeId: productType.id,
            fields: input.customFields, connection });
        }
        const previousGeneralMedia = (await dao.listProductMediaDetails({ tenantId, productId, connection }))
          .filter((item) => !item.variantId && !item.colorOptionId);
        await dao.clearProductMedia({ productId, connection });
        for (const [sortOrder, fileKey] of input.imageUrls.entries()) {
          let asset = await dao.findMediaAssetByKey({ tenantId, fileKey, connection });
          if (!asset) {
            asset = { id: createId() };
            const pathname = new URL(fileKey).pathname;
            await dao.insertMediaAsset({ asset: {
              ...asset, tenantId, fileKey,
              originalName: pathname.split("/").filter(Boolean).pop() || `product-image-${sortOrder + 1}`,
              altText: input.name, createdBy: context.actorUserId
            }, connection });
          } else if (asset.deleted) await dao.restoreMediaAsset({ assetId: asset.id, altText: input.name, connection });
          await dao.linkProductMedia({ media: {
            id: createId(), productId, assetId: asset.id,
            role: sortOrder === 0 ? "PRIMARY" : "GALLERY", sortOrder
          }, connection });
        }
        for (const media of previousGeneralMedia) {
          const orphaned = await dao.deleteMediaAssetIfUnused({ assetId: media.assetId, connection });
          if (orphaned) orphanedMediaUrls.push(media.url);
        }
        const event = { id: createId(), tenantId, aggregateId: productId,
          type: "catalog.product.updated",
          payload: { tenantId, productId, productCode: current.productCode, name: input.name } };
        await dao.insertAudit({ audit: { id: createId(), tenantId,
          actorUserId: context.actorUserId, action: event.type, entityId: productId,
          requestId: context.requestId, ipAddress: context.ipAddress || null,
          userAgent: context.userAgent?.slice(0, 500) || null, afterData: event.payload
        }, connection });
        await dao.insertOutbox({ event, connection });
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        throw appError("DUPLICATE_PRODUCT", "A product with the same name and code already exists.", 409);
      }
      throw error;
    }
    await Promise.all(orphanedMediaUrls.map((url) => mediaStorage.remove(url).catch(() => false)));
    return getProductVariants(tenantId, productId);
  }

  async function transitionProduct(tenantId, productId, action, context, input = {}) {
    return transaction(tenantId, async (connection) => {
      // Serialize decisions so competing requests cannot emit contradictory approval alerts.
      const current = await dao.findProductDetail({ tenantId, productId, connection, forUpdate: true });
      if (!current) throw appError("PRODUCT_NOT_FOUND", "The product could not be found.", 404);
      const transitions = {
        submit: {
          allowed: current.publicationStatus === "DRAFT"
            && ["DRAFT", "REJECTED"].includes(current.approvalStatus),
          message: "Only a draft or rejected product can be submitted.",
          approvalStatus: "PENDING", publicationStatus: "DRAFT", offerStatus: "PENDING"
        },
        approve: {
          allowed: current.publicationStatus === "DRAFT" && current.approvalStatus === "PENDING",
          message: "Only a pending product can be approved.",
          approvalStatus: "APPROVED", publicationStatus: "DRAFT", offerStatus: "DRAFT",
          approvedBy: context.actorUserId
        },
        reject: {
          allowed: current.publicationStatus === "DRAFT" && current.approvalStatus === "PENDING",
          message: "Only a pending product can be returned for changes.",
          approvalStatus: "REJECTED", publicationStatus: "DRAFT", offerStatus: "DRAFT"
        },
        publish: {
          allowed: current.publicationStatus === "DRAFT" && current.approvalStatus === "APPROVED",
          message: "Approve this product before publishing it.",
          approvalStatus: "APPROVED", publicationStatus: "PUBLISHED", offerStatus: "ACTIVE",
          approvedBy: context.actorUserId, approveOffers: true
        },
        archive: {
          allowed: current.publicationStatus !== "ARCHIVED",
          message: "This product is already archived.",
          approvalStatus: "DRAFT", publicationStatus: "ARCHIVED", offerStatus: "INACTIVE"
        },
        restore: {
          allowed: current.publicationStatus === "ARCHIVED",
          message: "Only an archived product can be restored.",
          approvalStatus: "DRAFT", publicationStatus: "DRAFT", offerStatus: "DRAFT"
        }
      };
      const transition = transitions[action];
      if (!transition) throw appError("INVALID_PRODUCT_ACTION", "That product action is not supported.", 422);
      if (!transition.allowed) throw appError("INVALID_PRODUCT_STATE", transition.message, 409);
      if (["submit", "publish"].includes(action)) {
        const readiness = await dao.findProductPublicationReadiness({ tenantId, productId, connection });
        const details = [
          !readiness?.hasCategory && { field: "categoryId", code: "required", message: "Select a category." },
          !readiness?.hasTaxCategory && { field: "taxCategoryId", code: "required", message: "Select a GST category." },
          !readiness?.hasHsnSacCode && { field: "hsnSacCode", code: "required", message: "Enter an HSN or SAC code." },
          !readiness?.variantCount && { field: "variants", code: "required", message: "Add at least one active variant." },
          readiness?.variantCount > readiness?.pricedVariantCount && {
            field: "prices", code: "incomplete",
            message: `Add an active price for all ${readiness.variantCount} variants.`
          }
        ].filter(Boolean);
        if (details.length) {
          throw appError("PRODUCT_NOT_READY",
            "Complete the catalog readiness requirements before submitting this product.", 409, details);
        }
      }
      const approvalNote = action === "reject" ? input.note
        : ["approve", "publish"].includes(action) ? (input.note || current.approvalNote || "") : "";
      await dao.updateProductWorkflow({ tenantId, productId,
        approvalStatus: transition.approvalStatus,
        publicationStatus: transition.publicationStatus,
        approvalNote, approvedBy: transition.approvedBy || null,
        offerStatus: transition.offerStatus,
        approveOffers: Boolean(transition.approveOffers), connection });
      const eventAction = { submit: "submitted", approve: "approved", reject: "rejected",
        publish: "published", archive: "archived", restore: "restored" }[action];
      const event = { id: createId(), tenantId, aggregateId: productId,
        type: `catalog.product.${eventAction}`,
        payload: { tenantId, productId, productCode: current.productCode,
          approvalStatus: transition.approvalStatus,
          publicationStatus: transition.publicationStatus,
          ...(approvalNote ? { note: approvalNote } : {}) } };
      await dao.insertAudit({ audit: { id: createId(), tenantId,
        actorUserId: context.actorUserId, action: event.type, entityId: productId,
        requestId: context.requestId, ipAddress: context.ipAddress || null,
        userAgent: context.userAgent?.slice(0, 500) || null, afterData: event.payload
      }, connection });
      await dao.insertOutbox({ event, connection });
      return { product: { ...current, approvalStatus: transition.approvalStatus,
        publicationStatus: transition.publicationStatus, approvalNote } };
    });
  }

  async function deleteProduct(tenantId, productId, context) {
    await transaction(tenantId, async (connection) => {
      const current = await dao.findProductDetail({ tenantId, productId, connection });
      if (!current) throw appError("PRODUCT_NOT_FOUND", "The product could not be found.", 404);
      if (current.approvalStatus !== "DRAFT"
        || !["DRAFT", "ARCHIVED"].includes(current.publicationStatus)) {
        throw appError("PRODUCT_DELETE_NOT_ALLOWED",
          "Only draft products can be deleted. Archive this product instead.", 409);
      }
      const dependencies = await dao.findProductDependencies({ tenantId, productId, connection });
      if (Object.values(dependencies).some((count) => count > 0)) {
        throw appError("PRODUCT_HAS_COMMERCE_HISTORY",
          "This product has inventory or transaction history and cannot be deleted. Archive it instead.", 409,
          Object.entries(dependencies).filter(([, count]) => count > 0).map(([field, count]) => ({
            field, code: "in_use", message: `${count} related record${count === 1 ? "" : "s"}`
          })));
      }
      const event = { id: createId(), tenantId, aggregateId: productId,
        type: "catalog.product.deleted",
        payload: { tenantId, productId, productCode: current.productCode } };
      await dao.insertAudit({ audit: { id: createId(), tenantId,
        actorUserId: context.actorUserId, action: event.type, entityId: productId,
        requestId: context.requestId, ipAddress: context.ipAddress || null,
        userAgent: context.userAgent?.slice(0, 500) || null, afterData: event.payload
      }, connection });
      await dao.insertOutbox({ event, connection });
      await dao.softDeleteProduct({ tenantId, productId, connection });
    });
  }

  async function updateProductPrices(tenantId, productId, input, context) {
    await ensureDefaults(tenantId);
    await transaction(tenantId, async (connection) => {
      const product = await dao.findProductSummary({ tenantId, productId, connection });
      if (!product) throw appError("PRODUCT_NOT_FOUND", "The product could not be found.", 404);
      const commerceScope = await dao.findDefaultCommerceScope({ tenantId, connection });
      const priceList = await dao.findDefaultPriceList({ tenantId, connection });
      if (!commerceScope || !priceList) {
        throw appError("CATALOG_COMMERCE_SCOPE_MISSING",
          "A default store, first-party merchant, and price list are required before products can be priced.", 409);
      }
      const variants = await dao.listProductVariants({ tenantId, productId,
        storeId: commerceScope.storeId, merchantId: commerceScope.merchantId,
        priceListId: priceList.id, connection });
      const variantsById = new Map(variants.map((variant) => [variant.id, variant]));
      for (const [index, pricing] of input.prices.entries()) {
        const variant = variantsById.get(pricing.variantId);
        if (!variant) {
          throw appError("INVALID_PRODUCT_VARIANT", "A selected variant does not belong to this product.", 422,
            [{ field: `prices.${index}.variantId`, code: "tenant_scope", message: "Select a variant from this product." }]);
        }
        if (pricing.salePrice > pricing.listPrice) {
          throw appError("INVALID_VARIANT_PRICE", "Selling price cannot be greater than MRP.", 422,
            [{ field: `prices.${index}.salePrice`, code: "maximum", message: "Enter a selling price at or below MRP." }]);
        }
        let offerId = variant.offerId;
        if (!offerId) {
          offerId = createId();
          await dao.insertSellerOffer({ offer: {
            id: offerId, tenantId, storeId: commerceScope.storeId, merchantId: commerceScope.merchantId,
            variantId: variant.id, sellerSku: variant.sku, taxCategoryId: null
          }, connection });
        } else {
          await dao.closeActiveOfferPrices({ offerId, priceListId: priceList.id, connection });
        }
        await dao.insertOfferPrice({ price: {
          id: createId(), tenantId, offerId, priceListId: priceList.id,
          listPrice: pricing.listPrice, salePrice: pricing.salePrice, costPrice: pricing.costPrice
        }, connection });
      }
      const event = { id: createId(), tenantId, aggregateId: productId,
        type: "catalog.product.prices.updated",
        payload: { tenantId, productId, variantCount: input.prices.length,
          storeId: commerceScope.storeId, merchantId: commerceScope.merchantId } };
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: event.type, entityId: productId, requestId: context.requestId,
        ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null,
        afterData: event.payload }, connection });
      await dao.insertOutbox({ event, connection });
    });
    return getProductVariants(tenantId, productId);
  }

  async function listProductMedia(tenantId, productId) {
    const product = await dao.findProductSummary({ tenantId, productId });
    if (!product) throw appError("PRODUCT_NOT_FOUND", "The product could not be found.", 404);
    const [variants, items] = await Promise.all([
      dao.listMediaVariants({ tenantId, productId }), dao.listProductMediaDetails({ tenantId, productId })
    ]);
    const colors = [...variants.reduce((groups, variant) => {
      if (!variant.colorOptionId) return groups;
      const current = groups.get(variant.colorOptionId) || { id: variant.colorOptionId,
        name: variant.colorName, swatchValue: variant.colorSwatch, variants: [] };
      current.variants.push({ id: variant.id, name: variant.name, sku: variant.sku });
      groups.set(variant.colorOptionId, current); return groups;
    }, new Map()).values()];
    return { product, variants, colors,
      items: items.map(({ assetId: _assetId, ...item }) => item), storageMode: "MANAGED_UPLOAD" };
  }

  async function validateMediaScope({ tenantId, productId, variantId, colorOptionId, connection }) {
    if (variantId) {
      const variant = await dao.findMediaVariant({ tenantId, productId, variantId, connection });
      if (!variant) throw appError("INVALID_PRODUCT_VARIANT", "Select a variant from this product.", 422);
    }
    if (colorOptionId) {
      const color = await dao.findMediaColor({ tenantId, productId, colorOptionId, connection });
      if (!color) throw appError("INVALID_PRODUCT_COLOR", "Select a colour used by this product.", 422);
    }
  }

  function sameMediaScope(item, scope) {
    return (item.variantId || null) === (scope.variantId || null)
      && (item.colorOptionId || null) === (scope.colorOptionId || null);
  }

  async function repairMediaScope({ tenantId, productId, variantId, colorOptionId, connection }) {
    const items = (await dao.listProductMediaDetails({ tenantId, productId, connection }))
      .filter((item) => sameMediaScope(item, { variantId, colorOptionId }));
    if (!items.length) return;
    await dao.reorderMedia({ productId, variantId, colorOptionId,
      mediaIds: items.map((item) => item.id), connection });
    if (!items.some((item) => item.role === "PRIMARY")) {
      await dao.setPrimaryMedia({ productId, variantId, colorOptionId,
        mediaId: items[0].id, connection });
    }
  }

  async function addProductMedia(tenantId, productId, input, context) {
    await transaction(tenantId, async (connection) => {
      const product = await dao.findProductSummary({ tenantId, productId, connection });
      if (!product) throw appError("PRODUCT_NOT_FOUND", "The product could not be found.", 404);
      await validateMediaScope({ tenantId, productId, variantId: input.variantId,
        colorOptionId: input.colorOptionId, connection });
      const count = await dao.countMediaScope({ productId, variantId: input.variantId,
        colorOptionId: input.colorOptionId, connection });
      if (count >= 20) throw appError("MEDIA_LIMIT_REACHED", "Each product or variant can contain up to 20 images.", 409);
      const duplicate = (await dao.listProductMediaDetails({ tenantId, productId, connection }))
        .some((item) => sameMediaScope(item, input) && item.url === input.url);
      if (duplicate) throw appError("PRODUCT_MEDIA_EXISTS", "This image is already linked to the selected gallery.", 409);
      let asset = await dao.findMediaAssetByKey({ tenantId, fileKey: input.url, connection });
      if (!asset) {
        asset = { id: createId() }; const pathname = new URL(input.url).pathname;
        await dao.insertMediaAsset({ asset: { ...asset, tenantId, fileKey: input.url,
          originalName: input.originalName || pathname.split("/").filter(Boolean).pop() || `product-image-${count + 1}`,
          mimeType: input.mimeType, byteSize: input.byteSize,
          altText: input.altText || product.name, createdBy: context.actorUserId }, connection });
      } else if (asset.deleted) await dao.restoreMediaAsset({ assetId: asset.id,
        altText: input.altText || product.name, connection });
      const mediaId = createId();
      await dao.linkProductMedia({ media: { id: mediaId, productId, variantId: input.variantId,
        colorOptionId: input.colorOptionId, assetId: asset.id, altText: input.altText,
        role: count === 0 ? "PRIMARY" : "GALLERY", sortOrder: count }, connection });
      const event = { id: createId(), tenantId, aggregateId: productId, type: "catalog.product.media.added",
        payload: { productId, mediaId, variantId: input.variantId || null,
          colorOptionId: input.colorOptionId || null, url: input.url } };
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: event.type, entityId: productId, requestId: context.requestId, ipAddress: context.ipAddress || null,
        userAgent: context.userAgent?.slice(0, 500) || null, afterData: event.payload }, connection });
      await dao.insertOutbox({ event, connection });
    });
    return listProductMedia(tenantId, productId);
  }

  async function updateProductMedia(tenantId, productId, mediaId, input, context) {
    let replacedFileUrl = null;
    await transaction(tenantId, async (connection) => {
      const current = await dao.findProductMedia({ tenantId, productId, mediaId, connection });
      if (!current) throw appError("PRODUCT_MEDIA_NOT_FOUND", "Product image was not found.", 404);
      await validateMediaScope({ tenantId, productId, variantId: input.variantId,
        colorOptionId: input.colorOptionId, connection });
      const targetScope = { variantId: input.variantId || null, colorOptionId: input.colorOptionId || null };
      const scopeChanged = !sameMediaScope(current, targetScope);
      const items = await dao.listProductMediaDetails({ tenantId, productId, connection });
      if (items.some((item) => item.id !== mediaId && sameMediaScope(item, targetScope)
        && item.url === input.url)) {
        throw appError("PRODUCT_MEDIA_EXISTS", "This image is already linked to the selected gallery.", 409);
      }
      const targetCount = await dao.countMediaScope({ productId, ...targetScope,
        excludeMediaId: mediaId, connection });
      if (scopeChanged && targetCount >= 20) {
        throw appError("MEDIA_LIMIT_REACHED", "The selected gallery already contains 20 images.", 409);
      }
      let assetId = current.assetId;
      if (input.url !== current.url) {
        let asset = await dao.findMediaAssetByKey({ tenantId, fileKey: input.url, connection });
        if (!asset) {
          asset = { id: createId() }; const pathname = new URL(input.url).pathname;
          await dao.insertMediaAsset({ asset: { ...asset, tenantId, fileKey: input.url,
            originalName: input.originalName || pathname.split("/").filter(Boolean).pop() || "product-image",
            mimeType: input.mimeType, byteSize: input.byteSize,
            altText: input.altText, createdBy: context.actorUserId }, connection });
        } else if (asset.deleted) {
          await dao.restoreMediaAsset({ assetId: asset.id, altText: input.altText, connection });
        }
        assetId = asset.id;
      }
      await dao.updateProductMediaLink({ mediaId, assetId, ...targetScope,
        altText: input.altText, role: scopeChanged ? (targetCount ? "GALLERY" : "PRIMARY") : current.role,
        sortOrder: scopeChanged ? targetCount : current.sortOrder, connection });
      if (assetId !== current.assetId) {
        const orphaned = await dao.deleteMediaAssetIfUnused({ assetId: current.assetId, connection });
        if (orphaned) replacedFileUrl = current.url;
      }
      if (scopeChanged) {
        await repairMediaScope({ tenantId, productId, variantId: current.variantId,
          colorOptionId: current.colorOptionId, connection });
        await repairMediaScope({ tenantId, productId, ...targetScope, connection });
      }
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "catalog.product.media.updated", entityId: productId, requestId: context.requestId,
        ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null,
        beforeData: { mediaId, url: current.url, altText: current.altText,
          variantId: current.variantId, colorOptionId: current.colorOptionId },
        afterData: { mediaId, url: input.url, altText: input.altText, ...targetScope } }, connection });
    });
    if (replacedFileUrl) await mediaStorage.remove(replacedFileUrl).catch(() => false);
    return listProductMedia(tenantId, productId);
  }

  async function uploadProductMedia(tenantId, productId, input, file, context) {
    const stored = await mediaStorage.store(file);
    try {
      return await addProductMedia(tenantId, productId, {
        ...input, url: stored.url, originalName: stored.originalName,
        mimeType: stored.mimeType, byteSize: stored.byteSize
      }, context);
    } catch (error) {
      await mediaStorage.remove(stored.url).catch(() => false);
      throw error;
    }
  }

  async function replaceProductMediaFile(tenantId, productId, mediaId, input, file, context) {
    const stored = await mediaStorage.store(file);
    try {
      return await updateProductMedia(tenantId, productId, mediaId, {
        ...input, url: stored.url, originalName: stored.originalName,
        mimeType: stored.mimeType, byteSize: stored.byteSize
      }, context);
    } catch (error) {
      await mediaStorage.remove(stored.url).catch(() => false);
      throw error;
    }
  }

  async function primaryProductMedia(tenantId, productId, mediaId, context) {
    await transaction(tenantId, async (connection) => {
      const media = await dao.findProductMedia({ tenantId, productId, mediaId, connection });
      if (!media) throw appError("PRODUCT_MEDIA_NOT_FOUND", "Product image was not found.", 404);
      await dao.setPrimaryMedia({ productId, variantId: media.variantId,
        colorOptionId: media.colorOptionId, mediaId, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "catalog.product.media.primary", entityId: productId, requestId: context.requestId,
        ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null,
        afterData: { productId, mediaId, variantId: media.variantId,
          colorOptionId: media.colorOptionId } }, connection });
    });
    return listProductMedia(tenantId, productId);
  }

  async function reorderProductMedia(tenantId, productId, mediaId, input, context) {
    await transaction(tenantId, async (connection) => {
      const media = await dao.findProductMedia({ tenantId, productId, mediaId, connection });
      if (!media) throw appError("PRODUCT_MEDIA_NOT_FOUND", "Product image was not found.", 404);
      const scope = (await dao.listProductMediaDetails({ tenantId, productId, connection }))
        .filter((item) => sameMediaScope(item, media)).map((item) => item.id);
      if (scope.length !== input.mediaIds.length || input.mediaIds.some((id) => !scope.includes(id))) {
        throw appError("MEDIA_ORDER_INVALID", "The image order must contain every image from the same product or variant group.", 422);
      }
      await dao.reorderMedia({ productId, variantId: media.variantId,
        colorOptionId: media.colorOptionId, mediaIds: input.mediaIds, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "catalog.product.media.reordered", entityId: productId, requestId: context.requestId,
        ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null,
        afterData: { productId, variantId: media.variantId,
          colorOptionId: media.colorOptionId, mediaIds: input.mediaIds } }, connection });
    });
    return listProductMedia(tenantId, productId);
  }

  async function removeProductMedia(tenantId, productId, mediaId, context) {
    let removedFileUrl = null;
    await transaction(tenantId, async (connection) => {
      const media = await dao.findProductMedia({ tenantId, productId, mediaId, connection });
      if (!media) throw appError("PRODUCT_MEDIA_NOT_FOUND", "Product image was not found.", 404);
      const orphaned = await dao.deleteProductMedia({ mediaId, assetId: media.assetId, connection });
      if (orphaned) removedFileUrl = media.url;
      const remaining = (await dao.listProductMediaDetails({ tenantId, productId, connection }))
        .filter((item) => sameMediaScope(item, media));
      if (remaining.length && !remaining.some((item) => item.role === "PRIMARY")) {
        await dao.setPrimaryMedia({ productId, variantId: media.variantId,
          colorOptionId: media.colorOptionId, mediaId: remaining[0].id, connection });
      }
      await repairMediaScope({ tenantId, productId, variantId: media.variantId,
        colorOptionId: media.colorOptionId, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "catalog.product.media.deleted", entityId: productId, requestId: context.requestId,
        ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null,
        afterData: { productId, mediaId, variantId: media.variantId,
          colorOptionId: media.colorOptionId, url: media.url } }, connection });
    });
    if (removedFileUrl) await mediaStorage.remove(removedFileUrl).catch(() => false);
    return listProductMedia(tenantId, productId);
  }

  async function listInventory(tenantId, input) {
    const [result, summary] = await Promise.all([
      dao.listInventory({ tenantId, ...input }), dao.summarizeInventory({ tenantId })
    ]);
    return { ...result, page: input.page, pageSize: input.pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / input.pageSize)), summary };
  }

  return { ensureDefaults, listProducts, createProduct, getProductVariants, updateProduct,
    updateProductPrices, transitionProduct, deleteProduct, listMasters, createMaster,
    updateMaster, listInventory, listProductMedia, addProductMedia, uploadProductMedia,
    updateProductMedia, replaceProductMediaFile, primaryProductMedia,
    reorderProductMedia, removeProductMedia };
}

const service = createCatalogService();
export const ensureDefaults = service.ensureDefaults;
export const listProducts = service.listProducts;
export const createProduct = service.createProduct;
export const getProductVariants = service.getProductVariants;
export const updateProduct = service.updateProduct;
export const updateProductPrices = service.updateProductPrices;
export const updateProductMedia = service.updateProductMedia;
export const transitionProduct = service.transitionProduct;
export const deleteProduct = service.deleteProduct;
export const listMasters = service.listMasters;
export const createMaster = service.createMaster;
export const updateMaster = service.updateMaster;
export const listInventory = service.listInventory;
export const listProductMedia = service.listProductMedia;
export const addProductMedia = service.addProductMedia;
export const uploadProductMedia = service.uploadProductMedia;
export const replaceProductMediaFile = service.replaceProductMediaFile;
export const primaryProductMedia = service.primaryProductMedia;
export const reorderProductMedia = service.reorderProductMedia;
export const removeProductMedia = service.removeProductMedia;
