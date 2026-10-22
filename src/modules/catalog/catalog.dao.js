import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

function number(value) {
  return value === null || value === undefined ? null : Number(value);
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function json(value) {
  if (!value) return {};
  return typeof value === "string" ? JSON.parse(value) : value;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function mapProduct(row) {
  return {
    id: bufferToUuid(row.id),
    productCode: row.product_code,
    name: row.name,
    vertical: row.vertical,
    productKind: row.product_kind,
    brandName: row.brand_name || null,
    categoryName: row.category_name || null,
    primaryImageUrl: row.primary_image_url || null,
    approvalStatus: row.approval_status,
    publicationStatus: row.publication_status,
    approvalNote: row.approval_note || "",
    hsnSacCode: row.hsn_sac_code,
    isReturnable: Boolean(row.is_returnable),
    returnWindowDays: number(row.return_window_days),
    variantCount: number(row.variant_count) || 0,
    availableQuantity: number(row.available_quantity) || 0,
    minimumPrice: number(row.minimum_price),
    maximumPrice: number(row.maximum_price),
    updatedAt: iso(row.updated_at)
  };
}

export async function listProducts({ tenantId, search, status, vertical, page, pageSize, connection = getPrimaryPool() }) {
  const where = ["p.tenant_id = ?", "p.deleted_at IS NULL"];
  const parameters = [uuidToBuffer(tenantId)];
  if (search) {
    const term = `%${escapeLike(search)}%`;
    where.push("(p.name LIKE ? ESCAPE '\\\\' OR p.product_code LIKE ? ESCAPE '\\\\' OR EXISTS (SELECT 1 FROM product_variants sx WHERE sx.product_id = p.id AND sx.deleted_at IS NULL AND sx.sku LIKE ? ESCAPE '\\\\'))");
    parameters.push(term, term, term);
  }
  if (status !== "ALL") {
    if (["PENDING", "APPROVED", "REJECTED"].includes(status)) {
      where.push("p.approval_status = ? AND p.publication_status = 'DRAFT'");
    } else if (status === "DRAFT") {
      where.push("p.approval_status = 'DRAFT' AND p.publication_status = 'DRAFT'");
    } else {
      where.push("p.publication_status = ?");
    }
    if (status !== "DRAFT") parameters.push(status);
  }
  if (vertical !== "ALL") {
    where.push("pt.vertical = ?");
    parameters.push(vertical);
  }
  const clause = where.join(" AND ");
  const offset = (page - 1) * pageSize;
  const [countRows] = await connection.execute(
    `SELECT COUNT(*) AS total FROM products p JOIN product_types pt ON pt.id = p.product_type_id WHERE ${clause}`,
    parameters
  );
  const [rows] = await connection.execute(
    `SELECT p.id, p.product_code, p.name, p.product_kind, p.approval_status,
            p.publication_status, p.approval_note, p.hsn_sac_code, p.is_returnable, p.return_window_days,
            p.updated_at, pt.vertical, b.name AS brand_name,
            (SELECT c.name FROM product_categories pc JOIN categories c ON c.id = pc.category_id
              WHERE pc.product_id = p.id ORDER BY pc.is_primary DESC LIMIT 1) AS category_name,
            (SELECT ma.file_key FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
              WHERE pm.product_id = p.id AND ma.deleted_at IS NULL
              ORDER BY (pm.media_role = 'PRIMARY') DESC, pm.sort_order LIMIT 1) AS primary_image_url,
            (SELECT COUNT(*) FROM product_variants pv
              WHERE pv.product_id = p.id AND pv.deleted_at IS NULL) AS variant_count,
            (SELECT MIN(op.sale_price)
               FROM product_variants pv
               JOIN seller_offers so ON so.variant_id = pv.id AND so.deleted_at IS NULL
               JOIN offer_prices op ON op.offer_id = so.id
              WHERE pv.product_id = p.id AND pv.deleted_at IS NULL
                AND op.ends_at IS NULL
                AND (op.starts_at IS NULL OR op.starts_at <= UTC_TIMESTAMP(6))) AS minimum_price,
            (SELECT MAX(op.sale_price)
               FROM product_variants pv
               JOIN seller_offers so ON so.variant_id = pv.id AND so.deleted_at IS NULL
               JOIN offer_prices op ON op.offer_id = so.id
              WHERE pv.product_id = p.id AND pv.deleted_at IS NULL
                AND op.ends_at IS NULL
                AND (op.starts_at IS NULL OR op.starts_at <= UTC_TIMESTAMP(6))) AS maximum_price,
            (SELECT COALESCE(SUM(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity), 0)
               FROM product_variants pv
               JOIN seller_offers so ON so.variant_id = pv.id AND so.deleted_at IS NULL
               JOIN inventory_balances ib ON ib.offer_id = so.id
              WHERE pv.product_id = p.id AND pv.deleted_at IS NULL) AS available_quantity
       FROM products p
       JOIN product_types pt ON pt.id = p.product_type_id
       LEFT JOIN brands b ON b.id = p.brand_id AND b.deleted_at IS NULL
      WHERE ${clause}
      ORDER BY p.updated_at DESC, p.id DESC
      LIMIT ? OFFSET ?`,
    [...parameters, pageSize, offset]
  );
  return { items: rows.map(mapProduct), total: Number(countRows[0].total) };
}

export async function summarizeProducts({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS total,
            SUM(publication_status = 'PUBLISHED') AS published,
            SUM(publication_status = 'DRAFT' AND approval_status = 'DRAFT') AS draft,
            SUM(approval_status = 'PENDING') AS pending
       FROM products WHERE tenant_id = ? AND deleted_at IS NULL`,
    [uuidToBuffer(tenantId)]
  );
  const row = rows[0];
  return { total: number(row.total) || 0, published: number(row.published) || 0,
    draft: number(row.draft) || 0, pending: number(row.pending) || 0 };
}

export async function listLookups({ tenantId, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const [[productTypes], [units], [brands], [categories], [taxCategories], [colors], [sizes]] = await Promise.all([
    connection.execute(`SELECT pt.id, pt.code, pt.name, pt.vertical, pt.lot_tracking_enabled,
        pt.serial_tracking_enabled, pt.expiry_tracking_enabled, pt.warranty_enabled,
        pt.variable_weight_enabled
      FROM product_types pt
      JOIN tenant_product_verticals tpv ON tpv.tenant_id = pt.tenant_id
        AND tpv.vertical = pt.vertical AND tpv.status = 'ACTIVE'
      WHERE pt.tenant_id = ? AND pt.deleted_at IS NULL
      ORDER BY FIELD(pt.vertical, 'GENERAL', 'GROCERY', 'ELECTRONICS', 'CLOTHING'), pt.name`, [tenant]),
    connection.execute("SELECT id, code, name, dimension, decimal_scale FROM units_of_measure WHERE tenant_id = ? ORDER BY dimension, name", [tenant]),
    connection.execute("SELECT id, name FROM brands WHERE tenant_id = ? AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY name", [tenant]),
    connection.execute("SELECT id, name, depth FROM categories WHERE tenant_id = ? AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY path, sort_order", [tenant]),
    connection.execute("SELECT id, code, name, hsn_sac_code FROM tax_categories WHERE tenant_id = ? AND status = 'ACTIVE' ORDER BY name", [tenant]),
    connection.execute("SELECT ao.id, ao.attribute_id, ao.display_label, ao.option_value, ao.swatch_value FROM attribute_options ao JOIN attribute_definitions ad ON ad.id = ao.attribute_id WHERE ao.tenant_id = ? AND ad.code = 'COLOR' AND ao.status = 'ACTIVE' AND ad.deleted_at IS NULL ORDER BY ao.sort_order, ao.display_label", [tenant]),
    connection.execute("SELECT ao.id, ao.attribute_id, ao.display_label, ao.option_value, ao.swatch_value FROM attribute_options ao JOIN attribute_definitions ad ON ad.id = ao.attribute_id WHERE ao.tenant_id = ? AND ad.code = 'SIZE' AND ao.status = 'ACTIVE' AND ad.deleted_at IS NULL ORDER BY ao.sort_order, ao.display_label", [tenant])
  ]);
  return {
    productTypes: productTypes.map((row) => ({ id: bufferToUuid(row.id), code: row.code, name: row.name, vertical: row.vertical,
      lotTracking: Boolean(row.lot_tracking_enabled), serialTracking: Boolean(row.serial_tracking_enabled),
      expiryTracking: Boolean(row.expiry_tracking_enabled), warranty: Boolean(row.warranty_enabled), variableWeight: Boolean(row.variable_weight_enabled) })),
    units: units.map((row) => ({ id: bufferToUuid(row.id), code: row.code, name: row.name, dimension: row.dimension, decimalScale: row.decimal_scale })),
    brands: brands.map((row) => ({ id: bufferToUuid(row.id), name: row.name })),
    categories: categories.map((row) => ({ id: bufferToUuid(row.id), name: row.name, depth: row.depth })),
    taxCategories: taxCategories.map((row) => ({ id: bufferToUuid(row.id), code: row.code, name: row.name, hsnSacCode: row.hsn_sac_code })),
    colors: colors.map((row) => ({ id: bufferToUuid(row.id), attributeId: bufferToUuid(row.attribute_id), name: row.display_label, value: row.option_value, swatchValue: row.swatch_value })),
    sizes: sizes.map((row) => ({ id: bufferToUuid(row.id), attributeId: bufferToUuid(row.attribute_id), name: row.display_label, value: row.option_value }))
  };
}

export async function listEnabledVerticals({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT vertical FROM tenant_product_verticals
      WHERE tenant_id = ? AND status = 'ACTIVE'
      ORDER BY FIELD(vertical, 'GENERAL', 'GROCERY', 'ELECTRONICS', 'CLOTHING'), vertical`,
    [uuidToBuffer(tenantId)]
  );
  return rows.map((row) => row.vertical);
}

export async function findEnabledProductType({ tenantId, vertical, connection = getPrimaryPool(), forUpdate = false }) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.execute(
    `SELECT pt.id, pt.code, pt.name, pt.vertical
       FROM tenant_product_verticals tpv
       JOIN product_types pt ON pt.tenant_id = tpv.tenant_id AND pt.vertical = tpv.vertical
      WHERE tpv.tenant_id = ? AND tpv.vertical = ? AND tpv.status = 'ACTIVE'
        AND pt.deleted_at IS NULL
      LIMIT 1${lock}`,
    [uuidToBuffer(tenantId), vertical]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), code: rows[0].code,
    name: rows[0].name, vertical: rows[0].vertical } : null;
}

export async function insertProductType({ type, connection }) {
  await connection.execute(
    `INSERT IGNORE INTO product_types (id, tenant_id, code, name, vertical, inventory_tracking_mode,
       variant_policy, lot_tracking_enabled, serial_tracking_enabled, expiry_tracking_enabled,
       warranty_enabled, variable_weight_enabled, configuration)
     VALUES (?, ?, ?, ?, ?, 'QUANTITY', 'OPTIONAL', ?, ?, ?, ?, ?, JSON_OBJECT())`,
    [uuidToBuffer(type.id), uuidToBuffer(type.tenantId), type.code, type.name, type.vertical,
      type.lotTracking, type.serialTracking, type.expiryTracking, type.warranty, type.variableWeight]
  );
}

export async function insertUnit({ unit, connection }) {
  await connection.execute(
    "INSERT IGNORE INTO units_of_measure (id, tenant_id, code, name, dimension, decimal_scale, is_system) VALUES (?, ?, ?, ?, ?, ?, 1)",
    [uuidToBuffer(unit.id), uuidToBuffer(unit.tenantId), unit.code, unit.name, unit.dimension, unit.decimalScale]
  );
}

export async function insertTaxCategory({ taxCategory, connection }) {
  await connection.execute(
    "INSERT IGNORE INTO tax_categories (id, tenant_id, code, name, supply_type, status) VALUES (?, ?, 'GST-GOODS', 'GST goods', 'GOODS', 'ACTIVE')",
    [uuidToBuffer(taxCategory.id), uuidToBuffer(taxCategory.tenantId)]
  );
}

export async function findBrandByName({ tenantId, name, connection }) {
  const [rows] = await connection.execute(
    "SELECT id FROM brands WHERE tenant_id = ? AND LOWER(name) = LOWER(?) AND deleted_at IS NULL LIMIT 1",
    [uuidToBuffer(tenantId), name]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id) } : null;
}

export async function insertBrand({ brand, connection }) {
  await connection.execute(
    "INSERT INTO brands (id, tenant_id, name, slug, status) VALUES (?, ?, ?, ?, 'ACTIVE')",
    [uuidToBuffer(brand.id), uuidToBuffer(brand.tenantId), brand.name, brand.slug]
  );
}

export async function findCategoryByName({ tenantId, name, connection }) {
  const [rows] = await connection.execute(
    "SELECT id FROM categories WHERE tenant_id = ? AND LOWER(name) = LOWER(?) AND deleted_at IS NULL LIMIT 1",
    [uuidToBuffer(tenantId), name]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id) } : null;
}

export async function insertCategory({ category, connection }) {
  await connection.execute(
    `INSERT INTO categories (id, tenant_id, parent_id, name, slug, path, depth, sort_order, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
    [uuidToBuffer(category.id), uuidToBuffer(category.tenantId),
      category.parentId ? uuidToBuffer(category.parentId) : null, category.name,
      category.slug, category.path || `/${category.slug}`, category.depth || 0, category.sortOrder || 0]
  );
}

export async function listMasters({ tenantId, masterType, search, status, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const term = `%${escapeLike(search || "")}%`;
  const statusClause = status === "ALL" ? "" : " AND source.status = ?";
  const parameters = search ? [tenant, term] : [tenant];
  if (status !== "ALL") parameters.push(status);
  if (masterType === "brands") {
    const [rows] = await connection.execute(
      `SELECT source.id, source.name, source.slug, source.status, source.created_at,
              (SELECT COUNT(*) FROM products p WHERE p.brand_id = source.id AND p.deleted_at IS NULL) AS usage_count
         FROM brands source
        WHERE source.tenant_id = ? AND source.deleted_at IS NULL
          ${search ? "AND source.name LIKE ? ESCAPE '\\\\'" : ""}${statusClause}
        ORDER BY source.name`, parameters);
    return rows.map((row) => ({ id: bufferToUuid(row.id), name: row.name, slug: row.slug,
      status: row.status, usageCount: number(row.usage_count) || 0, createdAt: iso(row.created_at) }));
  }
  if (masterType === "categories") {
    const [rows] = await connection.execute(
      `SELECT source.id, source.parent_id, source.name, source.slug, source.path,
              source.depth, source.status, source.created_at, parent.name AS parent_name,
              (SELECT COUNT(*) FROM product_categories pc WHERE pc.category_id = source.id) AS usage_count
         FROM categories source
         LEFT JOIN categories parent ON parent.id = source.parent_id
        WHERE source.tenant_id = ? AND source.deleted_at IS NULL
          ${search ? "AND source.name LIKE ? ESCAPE '\\\\'" : ""}${statusClause}
        ORDER BY source.path, source.sort_order, source.name`, parameters);
    return rows.map((row) => ({ id: bufferToUuid(row.id), parentId: bufferToUuid(row.parent_id),
      parentName: row.parent_name, name: row.name, slug: row.slug, path: row.path, depth: row.depth,
      status: row.status, usageCount: number(row.usage_count) || 0, createdAt: iso(row.created_at) }));
  }
  const code = masterType === "colors" ? "COLOR" : "SIZE";
  const [rows] = await connection.execute(
    `SELECT source.id, source.attribute_id, source.display_label AS name,
            source.option_value, source.swatch_value, source.status, source.created_at,
            (SELECT COUNT(*) FROM variant_attribute_values vav WHERE vav.option_id = source.id) AS usage_count
       FROM attribute_options source
       JOIN attribute_definitions ad ON ad.id = source.attribute_id
      WHERE source.tenant_id = ? AND ad.code = ? AND ad.deleted_at IS NULL
        ${search ? "AND source.display_label LIKE ? ESCAPE '\\\\'" : ""}${statusClause}
      ORDER BY source.sort_order, source.display_label`,
    search ? [tenant, code, term, ...(status === "ALL" ? [] : [status])]
      : [tenant, code, ...(status === "ALL" ? [] : [status])]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), attributeId: bufferToUuid(row.attribute_id),
    name: row.name, value: row.option_value, swatchValue: row.swatch_value, status: row.status,
    usageCount: number(row.usage_count) || 0, createdAt: iso(row.created_at) }));
}

export async function findCategoryById({ tenantId, categoryId, connection }) {
  const [rows] = await connection.execute(
    "SELECT id, path, depth FROM categories WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1",
    [uuidToBuffer(tenantId), uuidToBuffer(categoryId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), path: rows[0].path, depth: rows[0].depth } : null;
}

export async function updateBrandMaster({ tenantId, itemId, changes, connection }) {
  const assignments = [];
  const parameters = [];
  if (changes.name !== undefined) { assignments.push("name = ?", "slug = ?"); parameters.push(changes.name, changes.slug); }
  if (changes.status !== undefined) { assignments.push("status = ?"); parameters.push(changes.status); }
  parameters.push(uuidToBuffer(tenantId), uuidToBuffer(itemId));
  const [result] = await connection.execute(
    `UPDATE brands SET ${assignments.join(", ")} WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`, parameters
  );
  return result.affectedRows;
}

export async function updateCategoryMaster({ tenantId, itemId, changes, connection }) {
  const assignments = [];
  const parameters = [];
  if (changes.name !== undefined) { assignments.push("name = ?"); parameters.push(changes.name); }
  if (changes.status !== undefined) { assignments.push("status = ?"); parameters.push(changes.status); }
  parameters.push(uuidToBuffer(tenantId), uuidToBuffer(itemId));
  const [result] = await connection.execute(
    `UPDATE categories SET ${assignments.join(", ")} WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`, parameters
  );
  return result.affectedRows;
}

export async function updateAttributeOptionMaster({ tenantId, itemId, changes, connection }) {
  const assignments = [];
  const parameters = [];
  if (changes.name !== undefined) {
    assignments.push("display_label = ?", "option_value = ?");
    parameters.push(changes.name, changes.value);
  }
  if (changes.swatchValue !== undefined) { assignments.push("swatch_value = ?"); parameters.push(changes.swatchValue || null); }
  if (changes.status !== undefined) { assignments.push("status = ?"); parameters.push(changes.status); }
  parameters.push(uuidToBuffer(tenantId), uuidToBuffer(itemId));
  const [result] = await connection.execute(
    `UPDATE attribute_options SET ${assignments.join(", ")} WHERE tenant_id = ? AND id = ?`, parameters
  );
  return result.affectedRows;
}

export async function insertProduct({ product, connection }) {
  await connection.execute(
    `INSERT INTO products (id, tenant_id, product_type_id, brand_id, tax_category_id,
       product_code, name, slug, short_description, product_kind, approval_status,
       publication_status, hsn_sac_code, country_of_origin, manufacturer_name, is_returnable,
       return_window_days, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 'DRAFT', ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(product.id), uuidToBuffer(product.tenantId), uuidToBuffer(product.productTypeId),
      product.brandId ? uuidToBuffer(product.brandId) : null,
      product.taxCategoryId ? uuidToBuffer(product.taxCategoryId) : null,
      product.productCode, product.name, product.slug, product.shortDescription || null, product.productKind || "STANDARD",
      product.hsnSacCode || null, product.countryOfOrigin, product.manufacturerName || null, product.isReturnable,
      product.returnWindowDays, JSON.stringify(product.metadata || {})]
  );
}

export async function insertVariant({ variant, connection }) {
  await connection.execute(
    `INSERT INTO product_variants (id, tenant_id, product_id, sku, barcode, name,
       base_uom_id, selling_uom_id, pack_quantity, sold_by_weight,
       minimum_order_quantity, maximum_order_quantity, quantity_step,
       estimated_weight, minimum_weight, maximum_weight, weight_step, weight_uom_id,
       warranty_months, warranty_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(variant.id), uuidToBuffer(variant.tenantId), uuidToBuffer(variant.productId),
      variant.sku, variant.barcode || null, variant.name || null,
      uuidToBuffer(variant.baseUomId), uuidToBuffer(variant.sellingUomId), variant.packQuantity,
      variant.soldByWeight, variant.minimumOrderQuantity, variant.maximumOrderQuantity,
      variant.quantityStep, variant.estimatedWeight, variant.minimumWeight, variant.maximumWeight,
      variant.weightStep, variant.weightUomId ? uuidToBuffer(variant.weightUomId) : null,
      variant.warrantyMonths, variant.warrantyType || null]
  );
}

export async function findDefaultCommerceScope({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT s.id AS store_id, s.name AS store_name, s.base_currency,
            m.id AS merchant_id, m.display_name AS merchant_name
       FROM stores s
       JOIN store_merchants sm ON sm.store_id = s.id AND sm.status = 'ACTIVE'
       JOIN merchants m ON m.id = sm.merchant_id AND m.status = 'ACTIVE'
        AND m.merchant_type = 'FIRST_PARTY' AND m.deleted_at IS NULL
      WHERE s.tenant_id = ? AND s.status = 'ACTIVE' AND s.deleted_at IS NULL
      ORDER BY s.created_at, m.created_at
      LIMIT 1`,
    [uuidToBuffer(tenantId)]
  );
  if (!rows[0]) return null;
  return {
    storeId: bufferToUuid(rows[0].store_id),
    storeName: rows[0].store_name,
    merchantId: bufferToUuid(rows[0].merchant_id),
    merchantName: rows[0].merchant_name,
    currency: rows[0].base_currency
  };
}

export async function findDefaultPriceList({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT id, code, name, currency, includes_tax
       FROM price_lists
      WHERE tenant_id = ? AND code = 'DEFAULT_INR' AND status = 'ACTIVE'
      LIMIT 1`,
    [uuidToBuffer(tenantId)]
  );
  return rows[0] ? {
    id: bufferToUuid(rows[0].id), code: rows[0].code, name: rows[0].name,
    currency: rows[0].currency, includesTax: Boolean(rows[0].includes_tax)
  } : null;
}

export async function insertPriceList({ priceList, connection }) {
  await connection.execute(
    `INSERT INTO price_lists (id, tenant_id, store_id, code, name, currency,
       includes_tax, priority, status)
     VALUES (?, ?, NULL, 'DEFAULT_INR', 'Default retail price', ?, 1, 100, 'ACTIVE')`,
    [uuidToBuffer(priceList.id), uuidToBuffer(priceList.tenantId), priceList.currency]
  );
}

export async function findSellerOffer({ tenantId, storeId, merchantId, variantId, connection }) {
  const [rows] = await connection.execute(
    `SELECT id FROM seller_offers
      WHERE tenant_id = ? AND store_id = ? AND merchant_id = ? AND variant_id = ?
        AND deleted_at IS NULL
      LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(storeId), uuidToBuffer(merchantId), uuidToBuffer(variantId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id) } : null;
}

export async function insertSellerOffer({ offer, connection }) {
  await connection.execute(
    `INSERT INTO seller_offers (id, tenant_id, store_id, merchant_id, variant_id,
       seller_sku, status, fulfillment_type, handling_time_hours, tax_category_id)
     VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', 'MERCHANT', 0, ?)`,
    [uuidToBuffer(offer.id), uuidToBuffer(offer.tenantId), uuidToBuffer(offer.storeId),
      uuidToBuffer(offer.merchantId), uuidToBuffer(offer.variantId), offer.sellerSku,
      offer.taxCategoryId ? uuidToBuffer(offer.taxCategoryId) : null]
  );
}

export async function closeActiveOfferPrices({ offerId, priceListId, connection }) {
  await connection.execute(
    `UPDATE offer_prices
        SET ends_at = UTC_TIMESTAMP(6)
      WHERE offer_id = ? AND price_list_id = ? AND ends_at IS NULL`,
    [uuidToBuffer(offerId), uuidToBuffer(priceListId)]
  );
}

export async function insertOfferPrice({ price, connection }) {
  await connection.execute(
    `INSERT INTO offer_prices (id, tenant_id, offer_id, price_list_id,
       list_price, sale_price, cost_price, starts_at, ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), NULL)`,
    [uuidToBuffer(price.id), uuidToBuffer(price.tenantId), uuidToBuffer(price.offerId),
      uuidToBuffer(price.priceListId), price.listPrice, price.salePrice, price.costPrice]
  );
}

export async function listProductVariants({ tenantId, productId, storeId, merchantId, priceListId,
  connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT pv.id, pv.sku, pv.barcode, pv.name, pv.status,
            color.id AS color_id, color.display_label AS color_name, color.swatch_value,
            size.id AS size_id, size.display_label AS size_name,
            so.id AS offer_id, so.status AS offer_status,
            current_price.list_price, current_price.sale_price, current_price.cost_price,
            current_price.starts_at AS price_started_at
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id AND p.tenant_id = ? AND p.deleted_at IS NULL
       LEFT JOIN variant_attribute_values color_value ON color_value.variant_id = pv.id
        AND color_value.attribute_id = (SELECT id FROM attribute_definitions
          WHERE tenant_id = ? AND code = 'COLOR' AND deleted_at IS NULL LIMIT 1)
       LEFT JOIN attribute_options color ON color.id = color_value.option_id
       LEFT JOIN variant_attribute_values size_value ON size_value.variant_id = pv.id
        AND size_value.attribute_id = (SELECT id FROM attribute_definitions
          WHERE tenant_id = ? AND code = 'SIZE' AND deleted_at IS NULL LIMIT 1)
       LEFT JOIN attribute_options size ON size.id = size_value.option_id
       LEFT JOIN seller_offers so ON so.variant_id = pv.id AND so.store_id = ?
        AND so.merchant_id = ? AND so.deleted_at IS NULL
       LEFT JOIN offer_prices current_price ON current_price.id = (
         SELECT op.id FROM offer_prices op
          WHERE op.offer_id = so.id AND op.price_list_id = ? AND op.ends_at IS NULL
            AND (op.starts_at IS NULL OR op.starts_at <= UTC_TIMESTAMP(6))
          ORDER BY op.starts_at DESC, op.created_at DESC LIMIT 1
       )
      WHERE pv.tenant_id = ? AND pv.product_id = ? AND pv.deleted_at IS NULL
      ORDER BY color.display_label, size.display_label, pv.created_at, pv.sku`,
    [uuidToBuffer(tenantId), uuidToBuffer(tenantId), uuidToBuffer(tenantId),
      uuidToBuffer(storeId), uuidToBuffer(merchantId), uuidToBuffer(priceListId),
      uuidToBuffer(tenantId), uuidToBuffer(productId)]
  );
  return rows.map((row) => ({
    id: bufferToUuid(row.id), sku: row.sku, barcode: row.barcode, name: row.name,
    status: row.status, colorId: bufferToUuid(row.color_id), colorName: row.color_name || null,
    colorSwatch: row.swatch_value || null, sizeId: bufferToUuid(row.size_id),
    sizeName: row.size_name || null, offerId: bufferToUuid(row.offer_id),
    offerStatus: row.offer_status || null, listPrice: number(row.list_price),
    salePrice: number(row.sale_price), costPrice: number(row.cost_price),
    priceStartedAt: iso(row.price_started_at)
  }));
}

export async function findProductSummary({ tenantId, productId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT p.id, p.product_code, p.name, pt.vertical
       FROM products p JOIN product_types pt ON pt.id = p.product_type_id
      WHERE p.tenant_id = ? AND p.id = ? AND p.deleted_at IS NULL LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(productId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), productCode: rows[0].product_code,
    name: rows[0].name, vertical: rows[0].vertical } : null;
}

export async function findProductDetail({ tenantId, productId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT p.id, p.product_code, p.name, p.short_description, p.approval_status,
            p.publication_status, p.approval_note, p.brand_id, p.tax_category_id, p.hsn_sac_code,
            p.country_of_origin, p.manufacturer_name, p.is_returnable,
            p.return_window_days, p.metadata, pt.vertical,
            (SELECT pc.category_id FROM product_categories pc
              WHERE pc.product_id = p.id ORDER BY pc.is_primary DESC LIMIT 1) AS category_id
       FROM products p
       JOIN product_types pt ON pt.id = p.product_type_id
      WHERE p.tenant_id = ? AND p.id = ? AND p.deleted_at IS NULL
      LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(productId)]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  const metadata = json(row.metadata);
  return {
    id: bufferToUuid(row.id), productCode: row.product_code, name: row.name,
    shortDescription: row.short_description || "", vertical: row.vertical,
    brandId: bufferToUuid(row.brand_id), categoryId: bufferToUuid(row.category_id),
    taxCategoryId: bufferToUuid(row.tax_category_id), hsnSacCode: row.hsn_sac_code || "",
    countryOfOrigin: row.country_of_origin || "IN", manufacturerName: row.manufacturer_name || "",
    isReturnable: Boolean(row.is_returnable), returnWindowDays: number(row.return_window_days),
    approvalStatus: row.approval_status, publicationStatus: row.publication_status,
    approvalNote: row.approval_note || "",
    ingredients: metadata.grocery?.ingredients || "",
    storageInstructions: metadata.grocery?.storageInstructions || "",
    allowSubstitutions: Boolean(metadata.grocery?.allowSubstitutions),
    modelNumber: metadata.electronics?.modelNumber || "",
    gender: metadata.clothing?.gender || ""
  };
}

export async function listProductImages({ productId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT ma.file_key
       FROM product_media pm
       JOIN media_assets ma ON ma.id = pm.media_asset_id AND ma.deleted_at IS NULL
      WHERE pm.product_id = ? AND pm.variant_id IS NULL AND pm.color_option_id IS NULL
      ORDER BY (pm.media_role = 'PRIMARY') DESC, pm.sort_order`,
    [uuidToBuffer(productId)]
  );
  return rows.map((row) => row.file_key);
}

export async function listProductCustomFields({ tenantId, productId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT ad.id AS attribute_id, ad.name, ad.data_type,
            pav.value_text, pav.value_number, pav.value_boolean, pav.value_date
       FROM product_attribute_values pav
       JOIN attribute_definitions ad ON ad.id = pav.attribute_id
        AND ad.tenant_id = pav.tenant_id AND LEFT(ad.code, 7) = 'CUSTOM_'
      WHERE pav.tenant_id = ? AND pav.product_id = ? AND ad.deleted_at IS NULL
      ORDER BY pav.created_at, ad.name`,
    [uuidToBuffer(tenantId), uuidToBuffer(productId)]
  );
  return rows.map((row) => {
    let value = row.value_text || "";
    if (row.data_type === "NUMBER") value = number(row.value_number);
    if (row.data_type === "BOOLEAN") value = Boolean(row.value_boolean);
    if (row.data_type === "DATE") {
      value = row.value_date instanceof Date
        ? row.value_date.toISOString().slice(0, 10)
        : String(row.value_date || "").slice(0, 10);
    }
    return {
      attributeId: bufferToUuid(row.attribute_id), label: row.name,
      type: row.data_type, value
    };
  });
}

export async function clearProductCustomFields({ tenantId, productId, connection }) {
  await connection.execute(
    `DELETE pav FROM product_attribute_values pav
       JOIN attribute_definitions ad ON ad.id = pav.attribute_id
        AND ad.tenant_id = pav.tenant_id AND LEFT(ad.code, 7) = 'CUSTOM_'
      WHERE pav.tenant_id = ? AND pav.product_id = ?`,
    [uuidToBuffer(tenantId), uuidToBuffer(productId)]
  );
}

export async function findCustomAttributeDefinition({ tenantId, code, connection }) {
  const [rows] = await connection.execute(
    `SELECT id, name, data_type FROM attribute_definitions
      WHERE tenant_id = ? AND code = ? AND LEFT(code, 7) = 'CUSTOM_' AND deleted_at IS NULL
      LIMIT 1`,
    [uuidToBuffer(tenantId), code]
  );
  return rows[0] ? {
    id: bufferToUuid(rows[0].id), name: rows[0].name, dataType: rows[0].data_type
  } : null;
}

export async function insertProductAttributeValue({ field, connection }) {
  await connection.execute(
    `INSERT INTO product_attribute_values (
       id, tenant_id, product_id, attribute_id, option_id,
       value_text, value_number, value_boolean, value_date, value_json
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
    [uuidToBuffer(field.id), uuidToBuffer(field.tenantId), uuidToBuffer(field.productId),
      uuidToBuffer(field.attributeId), field.type === "TEXT" ? field.value : null,
      field.type === "NUMBER" ? field.value : null,
      field.type === "BOOLEAN" ? field.value : null,
      field.type === "DATE" ? field.value : null]
  );
}

export async function updateProduct({ product, connection }) {
  const [result] = await connection.execute(
    `UPDATE products
        SET brand_id = ?, tax_category_id = ?, name = ?, slug = ?, short_description = ?,
            hsn_sac_code = ?, country_of_origin = ?, manufacturer_name = ?,
            is_returnable = ?, return_window_days = ?, metadata = ?
      WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
    [product.brandId ? uuidToBuffer(product.brandId) : null,
      product.taxCategoryId ? uuidToBuffer(product.taxCategoryId) : null,
      product.name, product.slug, product.shortDescription || null, product.hsnSacCode || null,
      product.countryOfOrigin, product.manufacturerName || null, product.isReturnable,
      product.returnWindowDays, JSON.stringify(product.metadata || {}),
      uuidToBuffer(product.tenantId), uuidToBuffer(product.id)]
  );
  return result.affectedRows;
}

export async function replaceProductCategory({ productId, categoryId, connection }) {
  await connection.execute("DELETE FROM product_categories WHERE product_id = ?", [uuidToBuffer(productId)]);
  if (categoryId) await linkProductCategory({ productId, categoryId, connection });
}

export async function clearProductMedia({ productId, connection }) {
  await connection.execute(
    "DELETE FROM product_media WHERE product_id = ? AND variant_id IS NULL AND color_option_id IS NULL",
    [uuidToBuffer(productId)]
  );
}

export async function findProductDependencies({ tenantId, productId, connection }) {
  const [[row]] = await connection.execute(
    `SELECT
       (SELECT COUNT(*) FROM order_items oi JOIN product_variants pv ON pv.id = oi.variant_id
         WHERE oi.tenant_id = ? AND pv.product_id = ?) AS order_items,
       (SELECT COUNT(*) FROM inventory_balances ib JOIN seller_offers so ON so.id = ib.offer_id
         JOIN product_variants pv ON pv.id = so.variant_id
         WHERE ib.tenant_id = ? AND pv.product_id = ?) AS inventory_balances,
       (SELECT COUNT(*) FROM purchase_order_items poi JOIN seller_offers so ON so.id = poi.offer_id
         JOIN product_variants pv ON pv.id = so.variant_id
         WHERE so.tenant_id = ? AND pv.product_id = ?) AS purchase_items,
       (SELECT COUNT(*) FROM goods_receipt_items gri JOIN seller_offers so ON so.id = gri.offer_id
         JOIN product_variants pv ON pv.id = so.variant_id
         WHERE so.tenant_id = ? AND pv.product_id = ?) AS receipt_items,
       (SELECT COUNT(*) FROM stock_transfer_items sti JOIN seller_offers so ON so.id = sti.offer_id
         JOIN product_variants pv ON pv.id = so.variant_id
         WHERE so.tenant_id = ? AND pv.product_id = ?) AS transfer_items`,
    [uuidToBuffer(tenantId), uuidToBuffer(productId), uuidToBuffer(tenantId), uuidToBuffer(productId),
      uuidToBuffer(tenantId), uuidToBuffer(productId), uuidToBuffer(tenantId), uuidToBuffer(productId),
      uuidToBuffer(tenantId), uuidToBuffer(productId)]
  );
  return {
    orderItems: number(row.order_items) || 0,
    inventoryBalances: number(row.inventory_balances) || 0,
    purchaseItems: number(row.purchase_items) || 0,
    receiptItems: number(row.receipt_items) || 0,
    transferItems: number(row.transfer_items) || 0
  };
}

export async function updateProductLifecycle({ tenantId, productId, publicationStatus, offerStatus, connection }) {
  const tenant = uuidToBuffer(tenantId);
  const product = uuidToBuffer(productId);
  const [result] = await connection.execute(
    `UPDATE products SET publication_status = ?
      WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
    [publicationStatus, tenant, product]
  );
  if (!result.affectedRows) return 0;
  await connection.execute(
    `UPDATE seller_offers so JOIN product_variants pv ON pv.id = so.variant_id
        SET so.status = ?
      WHERE so.tenant_id = ? AND pv.product_id = ? AND so.deleted_at IS NULL`,
    [offerStatus, tenant, product]
  );
  return result.affectedRows;
}

export async function findProductPublicationReadiness({ tenantId, productId, connection }) {
  const [[row]] = await connection.execute(
    `SELECT p.tax_category_id, p.hsn_sac_code,
            EXISTS(SELECT 1 FROM product_categories pc WHERE pc.product_id = p.id) AS has_category,
            (SELECT COUNT(*) FROM product_variants pv
              WHERE pv.tenant_id = p.tenant_id AND pv.product_id = p.id
                AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL) AS variant_count,
            (SELECT COUNT(DISTINCT pv.id)
               FROM product_variants pv
               JOIN seller_offers so ON so.tenant_id = pv.tenant_id
                AND so.variant_id = pv.id AND so.deleted_at IS NULL
               JOIN offer_prices op ON op.tenant_id = so.tenant_id
                AND op.offer_id = so.id AND op.ends_at IS NULL
                AND (op.starts_at IS NULL OR op.starts_at <= UTC_TIMESTAMP(6))
              WHERE pv.tenant_id = p.tenant_id AND pv.product_id = p.id
                AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL) AS priced_variant_count
       FROM products p
      WHERE p.tenant_id = ? AND p.id = ? AND p.deleted_at IS NULL
      LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(productId)]
  );
  if (!row) return null;
  return {
    hasCategory: Boolean(row.has_category),
    hasTaxCategory: Boolean(row.tax_category_id),
    hasHsnSacCode: Boolean(row.hsn_sac_code),
    variantCount: number(row.variant_count) || 0,
    pricedVariantCount: number(row.priced_variant_count) || 0
  };
}

export async function updateProductWorkflow({ tenantId, productId, approvalStatus,
  publicationStatus, approvalNote, approvedBy, offerStatus, approveOffers, connection }) {
  const tenant = uuidToBuffer(tenantId);
  const product = uuidToBuffer(productId);
  const actor = approvedBy ? uuidToBuffer(approvedBy) : null;
  const [result] = await connection.execute(
    `UPDATE products
        SET approval_status = ?, publication_status = ?, approval_note = ?,
            approved_by = ?, approved_at = ${approvedBy ? "UTC_TIMESTAMP(6)" : "NULL"}
      WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
    [approvalStatus, publicationStatus, approvalNote || null, actor, tenant, product]
  );
  if (!result.affectedRows) return 0;
  await connection.execute(
    `UPDATE seller_offers so JOIN product_variants pv ON pv.id = so.variant_id
        SET so.status = ?, so.approved_by = ?,
            so.approved_at = ${approveOffers ? "UTC_TIMESTAMP(6)" : "NULL"}
      WHERE so.tenant_id = ? AND pv.product_id = ? AND so.deleted_at IS NULL`,
    [offerStatus, approveOffers ? actor : null, tenant, product]
  );
  return result.affectedRows;
}

export async function softDeleteProduct({ tenantId, productId, connection }) {
  const tenant = uuidToBuffer(tenantId);
  const product = uuidToBuffer(productId);
  await connection.execute(
    `UPDATE seller_offers so JOIN product_variants pv ON pv.id = so.variant_id
        SET so.status = 'INACTIVE', so.deleted_at = UTC_TIMESTAMP(6)
      WHERE so.tenant_id = ? AND pv.product_id = ? AND so.deleted_at IS NULL`,
    [tenant, product]
  );
  await connection.execute(
    `UPDATE product_variants SET status = 'INACTIVE', deleted_at = UTC_TIMESTAMP(6)
      WHERE tenant_id = ? AND product_id = ? AND deleted_at IS NULL`,
    [tenant, product]
  );
  const [result] = await connection.execute(
    `UPDATE products SET publication_status = 'ARCHIVED', deleted_at = UTC_TIMESTAMP(6)
      WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
    [tenant, product]
  );
  return result.affectedRows;
}

export async function linkProductCategory({ productId, categoryId, connection }) {
  await connection.execute(
    "INSERT INTO product_categories (product_id, category_id, is_primary) VALUES (?, ?, 1)",
    [uuidToBuffer(productId), uuidToBuffer(categoryId)]
  );
}

export async function findMediaAssetByKey({ tenantId, fileKey, connection }) {
  const [rows] = await connection.execute(
    "SELECT id, deleted_at FROM media_assets WHERE tenant_id = ? AND file_key = ? LIMIT 1",
    [uuidToBuffer(tenantId), fileKey]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), deleted: Boolean(rows[0].deleted_at) } : null;
}

export async function restoreMediaAsset({ assetId, altText, connection }) {
  await connection.execute("UPDATE media_assets SET deleted_at = NULL, alt_text = COALESCE(NULLIF(?, ''), alt_text) WHERE id = ?",
    [altText || "", uuidToBuffer(assetId)]);
}

export async function insertMediaAsset({ asset, connection }) {
  await connection.execute(
    `INSERT INTO media_assets (id, tenant_id, file_key, original_name, mime_type,
       byte_size, alt_text, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(asset.id), uuidToBuffer(asset.tenantId), asset.fileKey,
      asset.originalName, asset.mimeType || "text/uri-list", Number(asset.byteSize) || 0,
      asset.altText, uuidToBuffer(asset.createdBy)]
  );
}

export async function linkProductMedia({ media, connection }) {
  await connection.execute(
    `INSERT INTO product_media (id, product_id, variant_id, color_option_id, media_asset_id,
       alt_text_override, media_role, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(media.id), uuidToBuffer(media.productId), media.variantId ? uuidToBuffer(media.variantId) : null,
      media.colorOptionId ? uuidToBuffer(media.colorOptionId) : null, uuidToBuffer(media.assetId),
      media.altText || null, media.role, media.sortOrder]
  );
}

export async function listMediaVariants({ tenantId, productId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT pv.id, pv.sku, COALESCE(NULLIF(pv.name, ''), 'Standard') AS name,
            (SELECT ao.id FROM variant_attribute_values vav
              JOIN attribute_definitions ad ON ad.id = vav.attribute_id AND ad.code = 'COLOR'
              JOIN attribute_options ao ON ao.id = vav.option_id
              WHERE vav.variant_id = pv.id LIMIT 1) AS color_option_id,
            (SELECT ao.display_label FROM variant_attribute_values vav
              JOIN attribute_definitions ad ON ad.id = vav.attribute_id AND ad.code = 'COLOR'
              JOIN attribute_options ao ON ao.id = vav.option_id
              WHERE vav.variant_id = pv.id LIMIT 1) AS color_name,
            (SELECT ao.swatch_value FROM variant_attribute_values vav
              JOIN attribute_definitions ad ON ad.id = vav.attribute_id AND ad.code = 'COLOR'
              JOIN attribute_options ao ON ao.id = vav.option_id
              WHERE vav.variant_id = pv.id LIMIT 1) AS color_swatch
       FROM product_variants pv
      WHERE pv.tenant_id = ? AND pv.product_id = ? AND pv.deleted_at IS NULL
      ORDER BY pv.created_at, pv.sku`,
    [uuidToBuffer(tenantId), uuidToBuffer(productId)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), sku: row.sku, name: row.name,
    colorOptionId: bufferToUuid(row.color_option_id), colorName: row.color_name || null,
    colorSwatch: row.color_swatch || null }));
}

export async function listProductMediaDetails({ tenantId, productId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT pm.id, pm.variant_id, pm.color_option_id, pm.media_asset_id, pm.media_role, pm.sort_order,
            ma.file_key, COALESCE(pm.alt_text_override, ma.alt_text) AS alt_text,
            pv.sku, COALESCE(NULLIF(pv.name, ''), 'Standard') AS variant_name,
            COALESCE(media_color.display_label,
              MAX(CASE WHEN ad.code = 'COLOR' THEN ao.display_label END)) AS color_name,
            COALESCE(media_color.swatch_value,
              MAX(CASE WHEN ad.code = 'COLOR' THEN ao.swatch_value END)) AS color_swatch
       FROM product_media pm JOIN products p ON p.id = pm.product_id AND p.tenant_id = ? AND p.deleted_at IS NULL
       JOIN media_assets ma ON ma.id = pm.media_asset_id AND ma.deleted_at IS NULL
       LEFT JOIN attribute_options media_color ON media_color.id = pm.color_option_id
       LEFT JOIN product_variants pv ON pv.id = pm.variant_id AND pv.deleted_at IS NULL
       LEFT JOIN variant_attribute_values vav ON vav.variant_id = pv.id
       LEFT JOIN attribute_definitions ad ON ad.id = vav.attribute_id
       LEFT JOIN attribute_options ao ON ao.id = vav.option_id
      WHERE pm.product_id = ?
      GROUP BY pm.id, pm.variant_id, pm.color_option_id, pm.media_asset_id, pm.media_role, pm.sort_order,
        ma.file_key, ma.alt_text, pm.alt_text_override, pv.sku, pv.name,
        media_color.display_label, media_color.swatch_value
      ORDER BY pm.variant_id IS NOT NULL, pm.color_option_id IS NOT NULL, pm.color_option_id,
        pm.variant_id, pm.sort_order, pm.created_at`,
    [uuidToBuffer(tenantId), uuidToBuffer(productId)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), variantId: bufferToUuid(row.variant_id),
    colorOptionId: bufferToUuid(row.color_option_id), assetId: bufferToUuid(row.media_asset_id),
    role: row.media_role, sortOrder: Number(row.sort_order), url: row.file_key, altText: row.alt_text || "",
    variantSku: row.sku || null, variantName: row.variant_name || null,
    colorName: row.color_name || null, colorSwatch: row.color_swatch || null }));
}

export async function findMediaVariant({ tenantId, productId, variantId, connection }) {
  if (!variantId) return { id: null };
  const [rows] = await connection.execute(
    "SELECT id FROM product_variants WHERE tenant_id = ? AND product_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1",
    [uuidToBuffer(tenantId), uuidToBuffer(productId), uuidToBuffer(variantId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id) } : null;
}

export async function findMediaColor({ tenantId, productId, colorOptionId, connection }) {
  if (!colorOptionId) return { id: null };
  const [rows] = await connection.execute(
    `SELECT ao.id, ao.display_label, ao.swatch_value FROM product_variants pv
       JOIN variant_attribute_values vav ON vav.variant_id = pv.id
       JOIN attribute_definitions ad ON ad.id = vav.attribute_id AND ad.code = 'COLOR'
       JOIN attribute_options ao ON ao.id = vav.option_id
      WHERE pv.tenant_id = ? AND pv.product_id = ? AND ao.id = ? AND pv.deleted_at IS NULL LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(productId), uuidToBuffer(colorOptionId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), name: rows[0].display_label,
    swatchValue: rows[0].swatch_value || null } : null;
}

function mediaScope(scope) {
  if (scope.variantId) return { sql: "variant_id = ? AND color_option_id IS NULL", values: [uuidToBuffer(scope.variantId)] };
  if (scope.colorOptionId) return { sql: "variant_id IS NULL AND color_option_id = ?", values: [uuidToBuffer(scope.colorOptionId)] };
  return { sql: "variant_id IS NULL AND color_option_id IS NULL", values: [] };
}

export async function countMediaScope({ productId, variantId, colorOptionId, excludeMediaId = null, connection }) {
  const scope = mediaScope({ variantId, colorOptionId });
  const [[row]] = await connection.execute(
    `SELECT COUNT(*) AS total FROM product_media WHERE product_id = ? AND ${scope.sql}${excludeMediaId ? " AND id <> ?" : ""}`,
    [uuidToBuffer(productId), ...scope.values, ...(excludeMediaId ? [uuidToBuffer(excludeMediaId)] : [])]
  );
  return Number(row.total);
}

export async function findProductMedia({ tenantId, productId, mediaId, connection }) {
  const [rows] = await connection.execute(
    `SELECT pm.id, pm.variant_id, pm.color_option_id, pm.media_asset_id, pm.media_role,
            pm.sort_order, ma.file_key, COALESCE(pm.alt_text_override, ma.alt_text) AS alt_text
       FROM product_media pm JOIN products p ON p.id = pm.product_id AND p.tenant_id = ? AND p.deleted_at IS NULL
       JOIN media_assets ma ON ma.id = pm.media_asset_id AND ma.deleted_at IS NULL
      WHERE pm.product_id = ? AND pm.id = ? LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(productId), uuidToBuffer(mediaId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), variantId: bufferToUuid(rows[0].variant_id),
    colorOptionId: bufferToUuid(rows[0].color_option_id),
    assetId: bufferToUuid(rows[0].media_asset_id), role: rows[0].media_role,
    sortOrder: Number(rows[0].sort_order), url: rows[0].file_key, altText: rows[0].alt_text || "" } : null;
}

export async function setPrimaryMedia({ productId, variantId, colorOptionId, mediaId, connection }) {
  const scope = mediaScope({ variantId, colorOptionId });
  await connection.execute(
    `UPDATE product_media SET media_role = 'GALLERY' WHERE product_id = ? AND ${scope.sql}`,
    [uuidToBuffer(productId), ...scope.values]
  );
  await connection.execute("UPDATE product_media SET media_role = 'PRIMARY' WHERE id = ?", [uuidToBuffer(mediaId)]);
}

export async function reorderMedia({ productId, variantId, colorOptionId, mediaIds, connection }) {
  const scope = mediaScope({ variantId, colorOptionId });
  for (const [sortOrder, mediaId] of mediaIds.entries()) {
    await connection.execute(
      `UPDATE product_media SET sort_order = ? WHERE id = ? AND product_id = ? AND ${scope.sql}`,
      [sortOrder, uuidToBuffer(mediaId), uuidToBuffer(productId), ...scope.values]
    );
  }
}

export async function updateProductMediaLink({ mediaId, assetId, variantId, colorOptionId,
  altText, role, sortOrder, connection }) {
  await connection.execute(
    `UPDATE product_media SET media_asset_id = ?, variant_id = ?, color_option_id = ?,
       alt_text_override = ?, media_role = ?, sort_order = ? WHERE id = ?`,
    [uuidToBuffer(assetId), variantId ? uuidToBuffer(variantId) : null,
      colorOptionId ? uuidToBuffer(colorOptionId) : null, altText || null, role, sortOrder,
      uuidToBuffer(mediaId)]
  );
}

export async function deleteMediaAssetIfUnused({ assetId, connection }) {
  const [[usage]] = await connection.execute(
    "SELECT COUNT(*) AS total FROM product_media WHERE media_asset_id = ?", [uuidToBuffer(assetId)]);
  if (Number(usage.total)) return false;
  await connection.execute(
    "UPDATE media_assets SET deleted_at = UTC_TIMESTAMP(6) WHERE id = ?", [uuidToBuffer(assetId)]);
  return true;
}

export async function deleteProductMedia({ mediaId, assetId, connection }) {
  await connection.execute("DELETE FROM product_media WHERE id = ?", [uuidToBuffer(mediaId)]);
  return deleteMediaAssetIfUnused({ assetId, connection });
}

export async function findAttributeDefinition({ tenantId, code, connection }) {
  const [rows] = await connection.execute(
    "SELECT id FROM attribute_definitions WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1",
    [uuidToBuffer(tenantId), code]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id) } : null;
}

export async function insertAttributeDefinition({ attribute, connection }) {
  await connection.execute(
    `INSERT INTO attribute_definitions (id, tenant_id, code, name, data_type,
       is_variant_axis, is_required, is_filterable, is_searchable, validation_rules)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [uuidToBuffer(attribute.id), uuidToBuffer(attribute.tenantId), attribute.code,
      attribute.name, attribute.dataType || "OPTION", attribute.isVariantAxis,
      attribute.isFilterable ?? true, attribute.isSearchable ?? false,
      attribute.validationRules ? JSON.stringify(attribute.validationRules) : null]
  );
}

export async function linkProductTypeAttribute({ productTypeId, attributeId, sortOrder, group = "Variant options", connection }) {
  await connection.execute(
    `INSERT IGNORE INTO product_type_attributes (product_type_id, attribute_id, attribute_group, sort_order)
     VALUES (?, ?, ?, ?)`,
    [uuidToBuffer(productTypeId), uuidToBuffer(attributeId), group, sortOrder]
  );
}

export async function findAttributeOption({ attributeId, value, connection }) {
  const [rows] = await connection.execute(
    "SELECT id FROM attribute_options WHERE attribute_id = ? AND LOWER(option_value) = LOWER(?) LIMIT 1",
    [uuidToBuffer(attributeId), value]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id) } : null;
}

export async function insertAttributeOption({ option, connection }) {
  await connection.execute(
    `INSERT INTO attribute_options (id, tenant_id, attribute_id, option_value, display_label, swatch_value, sort_order, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
    [uuidToBuffer(option.id), uuidToBuffer(option.tenantId), uuidToBuffer(option.attributeId),
      option.value, option.label, option.swatchValue || null, option.sortOrder || 0]
  );
}

export async function insertVariantAttributeValue({ value, connection }) {
  await connection.execute(
    `INSERT INTO variant_attribute_values (id, tenant_id, variant_id, attribute_id, option_id)
     VALUES (?, ?, ?, ?, ?)`,
    [uuidToBuffer(value.id), uuidToBuffer(value.tenantId), uuidToBuffer(value.variantId),
      uuidToBuffer(value.attributeId), uuidToBuffer(value.optionId)]
  );
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(
    `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type,
       entity_id, request_id, ip_address, user_agent, after_data)
     VALUES (?, ?, ?, 'USER', ?, ?, ?, ?, INET6_ATON(?), ?, ?)`,
    [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId),
      audit.action, audit.entityType || "PRODUCT", uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress,
      audit.userAgent, JSON.stringify(audit.afterData)]
  );
}

export async function insertOutbox({ event, connection }) {
  await connection.execute(
    "INSERT INTO outbox_events (id, tenant_id, aggregate_type, aggregate_id, event_type, payload) VALUES (?, ?, ?, ?, ?, ?)",
    [uuidToBuffer(event.id), uuidToBuffer(event.tenantId), event.aggregateType || "PRODUCT",
      uuidToBuffer(event.aggregateId), event.type, JSON.stringify(event.payload)]
  );
}

function mapInventory(row) {
  const available = number(row.available_quantity) || 0;
  const reorderPoint = number(row.reorder_point_quantity);
  return {
    id: bufferToUuid(row.id), sku: row.sku, productName: row.product_name,
    variantName: row.variant_name, warehouseName: row.warehouse_name,
    merchantName: row.merchant_name, onHandQuantity: number(row.on_hand_quantity) || 0,
    reservedQuantity: number(row.reserved_quantity) || 0,
    quarantineQuantity: number(row.quarantine_quantity) || 0,
    availableQuantity: available, safetyStockQuantity: number(row.safety_stock_quantity) || 0,
    reorderPointQuantity: reorderPoint, reorderQuantity: number(row.reorder_quantity),
    health: available <= 0 ? "OUT" : reorderPoint !== null && available <= reorderPoint ? "LOW" : "HEALTHY",
    lotCount: number(row.lot_count) || 0, expiringLotCount: number(row.expiring_lot_count) || 0,
    availableSerialCount: number(row.available_serial_count) || 0,
    lastMovementAt: iso(row.last_movement_at)
  };
}

export async function listInventory({ tenantId, search, health, warehouseId, page, pageSize, connection = getPrimaryPool() }) {
  const where = ["ib.tenant_id = ?"];
  const parameters = [uuidToBuffer(tenantId)];
  if (search) {
    const term = `%${escapeLike(search)}%`;
    where.push("(p.name LIKE ? ESCAPE '\\\\' OR pv.sku LIKE ? ESCAPE '\\\\' OR w.name LIKE ? ESCAPE '\\\\')");
    parameters.push(term, term, term);
  }
  if (warehouseId) { where.push("ib.warehouse_id = ?"); parameters.push(uuidToBuffer(warehouseId)); }
  const availableSql = "(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity)";
  if (health === "OUT") where.push(`${availableSql} <= 0`);
  if (health === "LOW") where.push(`${availableSql} > 0 AND ib.reorder_point_quantity IS NOT NULL AND ${availableSql} <= ib.reorder_point_quantity`);
  if (health === "HEALTHY") where.push(`${availableSql} > 0 AND (ib.reorder_point_quantity IS NULL OR ${availableSql} > ib.reorder_point_quantity)`);
  const clause = where.join(" AND ");
  const offset = (page - 1) * pageSize;
  const [countRows] = await connection.execute(`SELECT COUNT(*) AS total FROM inventory_balances ib JOIN seller_offers so ON so.id = ib.offer_id JOIN product_variants pv ON pv.id = so.variant_id JOIN products p ON p.id = pv.product_id JOIN warehouses w ON w.id = ib.warehouse_id WHERE ${clause}`, parameters);
  const [rows] = await connection.execute(
    `SELECT ib.id, pv.sku, p.name AS product_name, pv.name AS variant_name,
            w.name AS warehouse_name, m.display_name AS merchant_name,
            ib.on_hand_quantity, ib.reserved_quantity, ib.quarantine_quantity,
            ${availableSql} AS available_quantity, ib.safety_stock_quantity,
            ib.reorder_point_quantity, ib.reorder_quantity, ib.last_movement_at,
            (SELECT COUNT(*) FROM inventory_lots il WHERE il.inventory_balance_id = ib.id AND il.status = 'ACTIVE') AS lot_count,
            (SELECT COUNT(*) FROM inventory_lots il WHERE il.inventory_balance_id = ib.id AND il.status = 'ACTIVE' AND il.expires_at BETWEEN UTC_DATE() AND DATE_ADD(UTC_DATE(), INTERVAL 30 DAY)) AS expiring_lot_count,
            (SELECT COUNT(*) FROM serial_numbers sn WHERE sn.inventory_balance_id = ib.id AND sn.status = 'AVAILABLE') AS available_serial_count
       FROM inventory_balances ib
       JOIN seller_offers so ON so.id = ib.offer_id
       JOIN product_variants pv ON pv.id = so.variant_id
       JOIN products p ON p.id = pv.product_id
       JOIN warehouses w ON w.id = ib.warehouse_id
       JOIN merchants m ON m.id = w.merchant_id
      WHERE ${clause}
      ORDER BY (available_quantity <= 0) DESC, (available_quantity <= COALESCE(ib.reorder_point_quantity, -1)) DESC, p.name
      LIMIT ? OFFSET ?`,
    [...parameters, pageSize, offset]
  );
  return { items: rows.map(mapInventory), total: Number(countRows[0].total) };
}

export async function summarizeInventory({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS total,
            SUM((on_hand_quantity - reserved_quantity - quarantine_quantity) <= 0) AS out_of_stock,
            SUM((on_hand_quantity - reserved_quantity - quarantine_quantity) > 0 AND reorder_point_quantity IS NOT NULL AND (on_hand_quantity - reserved_quantity - quarantine_quantity) <= reorder_point_quantity) AS low_stock,
            SUM(on_hand_quantity - reserved_quantity - quarantine_quantity) AS available
       FROM inventory_balances WHERE tenant_id = ?`, [uuidToBuffer(tenantId)]
  );
  const [lotRows] = await connection.execute(
    `SELECT COUNT(*) AS expiring FROM inventory_lots
      WHERE tenant_id = ? AND status = 'ACTIVE' AND expires_at BETWEEN UTC_DATE() AND DATE_ADD(UTC_DATE(), INTERVAL 30 DAY)`,
    [uuidToBuffer(tenantId)]
  );
  const row = rows[0];
  return { total: number(row.total) || 0, available: number(row.available) || 0,
    lowStock: number(row.low_stock) || 0, outOfStock: number(row.out_of_stock) || 0,
    expiringLots: number(lotRows[0].expiring) || 0 };
}
