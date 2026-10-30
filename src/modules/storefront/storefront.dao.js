import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";

// Every public query starts from an active tenant/store and eligible, dated offers.
export async function resolveStore({ tenantCode, storeCode, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT t.id AS tenant_id, t.display_name,
    s.id AS store_id, s.name, s.code, s.base_currency FROM tenants t
    JOIN stores s ON s.tenant_id = t.id AND s.status = 'ACTIVE' AND s.deleted_at IS NULL
    WHERE t.code = ? AND t.status = 'ACTIVE' AND t.deleted_at IS NULL AND s.code = ? LIMIT 1`,
  [tenantCode, storeCode]);
  const row = rows[0];
  return row ? { tenantId: bufferToUuid(row.tenant_id), storeId: bufferToUuid(row.store_id),
    tenantName: row.display_name, name: row.name, code: row.code, currency: row.base_currency } : null;
}

const stock = `COALESCE((SELECT SUM(GREATEST(0, LEAST(
  ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity - ib.safety_stock_quantity,
  CASE WHEN pt.serial_tracking_enabled = 1 THEN
    (SELECT COUNT(*) FROM serial_numbers sn WHERE sn.tenant_id = so.tenant_id
      AND sn.inventory_balance_id = ib.id AND sn.status = 'AVAILABLE')
  WHEN pt.lot_tracking_enabled = 1 THEN
    (SELECT COALESCE(SUM(GREATEST(0, il.on_hand_quantity - il.reserved_quantity - il.quarantine_quantity)), 0)
      FROM inventory_lots il WHERE il.tenant_id = so.tenant_id AND il.inventory_balance_id = ib.id
      AND il.status = 'ACTIVE' AND (il.expires_at IS NULL OR il.expires_at >= UTC_DATE()))
  ELSE ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity END)))
  FROM inventory_balances ib JOIN warehouses w ON w.id = ib.warehouse_id
    AND w.tenant_id = so.tenant_id AND w.merchant_id = so.merchant_id
    AND (w.store_id IS NULL OR w.store_id = so.store_id)
    AND w.status = 'ACTIVE' AND w.deleted_at IS NULL
  WHERE ib.tenant_id = so.tenant_id AND ib.offer_id = so.id), 0)`;

const offersCte = `WITH RECURSIVE eligible AS (
  SELECT so.id AS offer_id, so.tenant_id, so.merchant_id, pv.id AS variant_id, p.id AS product_id,
    p.product_kind, pv.sku, pv.name AS variant_name, COALESCE(so.minimum_order_quantity, pv.minimum_order_quantity) AS minimum_order_quantity,
    COALESCE(so.maximum_order_quantity, pv.maximum_order_quantity) AS maximum_order_quantity, pv.quantity_step, pv.sold_by_weight, pv.warranty_months,
    pv.warranty_type, m.display_name AS seller_name, op.sale_price, op.list_price,
    pl.includes_tax, u.code AS uom, ${stock} AS raw_stock
  FROM seller_offers so
  JOIN product_variants pv ON pv.id = so.variant_id AND pv.tenant_id = so.tenant_id
    AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL
  JOIN products p ON p.id = pv.product_id AND p.tenant_id = so.tenant_id
    AND p.publication_status = 'PUBLISHED' AND p.approval_status = 'APPROVED' AND p.deleted_at IS NULL
  JOIN product_types pt ON pt.id = p.product_type_id AND pt.tenant_id = p.tenant_id AND pt.deleted_at IS NULL
  JOIN tenant_product_verticals tpv ON tpv.tenant_id = p.tenant_id AND tpv.vertical = pt.vertical AND tpv.status = 'ACTIVE'
  JOIN merchants m ON m.id = so.merchant_id AND m.tenant_id = so.tenant_id AND m.deleted_at IS NULL
    AND m.status = 'ACTIVE'
    AND (m.merchant_type = 'FIRST_PARTY' OR (m.merchant_type = 'VENDOR' AND EXISTS (
      SELECT 1 FROM vendor_profiles vp WHERE vp.merchant_id = m.id AND vp.tenant_id = m.tenant_id
        AND vp.onboarding_status = 'APPROVED')))
  JOIN store_merchants sm ON sm.store_id = so.store_id AND sm.merchant_id = so.merchant_id AND sm.status = 'ACTIVE'
  JOIN units_of_measure u ON u.id = pv.selling_uom_id
  JOIN offer_prices op ON op.id = (
    SELECT current_price.id FROM offer_prices current_price
    JOIN price_lists current_list ON current_list.id = current_price.price_list_id
      AND current_list.tenant_id = so.tenant_id AND current_list.status = 'ACTIVE'
      AND current_list.currency = ? AND current_list.code = 'DEFAULT_INR'
      AND (current_list.starts_at IS NULL OR current_list.starts_at <= UTC_TIMESTAMP(6))
      AND (current_list.ends_at IS NULL OR current_list.ends_at > UTC_TIMESTAMP(6))
      AND (current_list.store_id IS NULL OR current_list.store_id = so.store_id)
    WHERE current_price.offer_id = so.id AND current_price.tenant_id = so.tenant_id
      AND (current_price.starts_at IS NULL OR current_price.starts_at <= UTC_TIMESTAMP(6))
      AND (current_price.ends_at IS NULL OR current_price.ends_at > UTC_TIMESTAMP(6))
    ORDER BY current_price.starts_at DESC, current_price.id DESC LIMIT 1)
  JOIN price_lists pl ON pl.id = op.price_list_id
  WHERE so.tenant_id = ? AND so.store_id = ? AND so.status = 'ACTIVE' AND so.deleted_at IS NULL
), component_tree AS (
  SELECT e.offer_id AS root_offer, e.tenant_id, e.merchant_id, pc.component_variant_id,
    CAST(pc.quantity AS DECIMAL(30,6)) AS quantity, 1 AS depth,
    CAST(CONCAT(HEX(e.variant_id), ',', HEX(pc.component_variant_id)) AS CHAR(1200)) AS path
  FROM eligible e JOIN product_bundle_components pc ON pc.bundle_variant_id = e.variant_id
    AND pc.tenant_id = e.tenant_id AND pc.is_optional = 0 WHERE e.product_kind = 'BUNDLE'
  UNION ALL
  SELECT tree.root_offer, tree.tenant_id, tree.merchant_id, pc.component_variant_id,
    CAST(tree.quantity * pc.quantity AS DECIMAL(30,6)), tree.depth + 1,
    CONCAT(tree.path, ',', HEX(pc.component_variant_id))
  FROM component_tree tree
  JOIN product_bundle_components pc ON pc.bundle_variant_id = tree.component_variant_id AND pc.tenant_id = tree.tenant_id AND pc.is_optional = 0
  WHERE tree.depth < 16 AND FIND_IN_SET(HEX(pc.component_variant_id), tree.path) = 0
), leaf_requirements AS (
  SELECT tree.root_offer, tree.merchant_id, tree.component_variant_id, SUM(tree.quantity) AS quantity
  FROM component_tree tree JOIN product_variants pv ON pv.id = tree.component_variant_id AND pv.tenant_id = tree.tenant_id
  JOIN products p ON p.id = pv.product_id AND p.tenant_id = tree.tenant_id WHERE p.product_kind <> 'BUNDLE'
  GROUP BY tree.root_offer, tree.merchant_id, tree.component_variant_id
), bundle_stock AS (
  SELECT leaf.root_offer, MIN(FLOOR(COALESCE(component.raw_stock, 0) / NULLIF(leaf.quantity, 0))) AS available
  FROM leaf_requirements leaf LEFT JOIN eligible component ON component.variant_id = leaf.component_variant_id
    AND component.merchant_id = leaf.merchant_id GROUP BY leaf.root_offer
), invalid_bundles AS (
  SELECT DISTINCT tree.root_offer FROM component_tree tree
  LEFT JOIN product_variants pv ON pv.id = tree.component_variant_id AND pv.tenant_id = tree.tenant_id AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL
  LEFT JOIN products p ON p.id = pv.product_id AND p.tenant_id = tree.tenant_id AND p.deleted_at IS NULL
  WHERE p.id IS NULL OR tree.quantity <= 0 OR (p.product_kind = 'BUNDLE' AND (
    tree.depth >= 16 OR NOT EXISTS (SELECT 1 FROM product_bundle_components pc
      WHERE pc.tenant_id = tree.tenant_id AND pc.bundle_variant_id = tree.component_variant_id AND pc.is_optional = 0)
    OR EXISTS (SELECT 1 FROM product_bundle_components pc WHERE pc.tenant_id = tree.tenant_id
      AND pc.bundle_variant_id = tree.component_variant_id AND pc.is_optional = 0
      AND FIND_IN_SET(HEX(pc.component_variant_id), tree.path) > 0)))
), sellable AS (
  SELECT e.*, CASE WHEN e.product_kind = 'BUNDLE' THEN
    CASE WHEN EXISTS (SELECT 1 FROM invalid_bundles invalid WHERE invalid.root_offer = e.offer_id) THEN 0 ELSE COALESCE(bs.available, 0) END
    ELSE e.raw_stock END AS available_quantity
  FROM eligible e LEFT JOIN bundle_stock bs ON bs.root_offer = e.offer_id
), ranked AS (
  SELECT e.*, ROW_NUMBER() OVER (PARTITION BY e.product_id
    ORDER BY (e.available_quantity >= e.minimum_order_quantity) DESC, e.sale_price, e.offer_id) AS position
  FROM sellable e
), catalog AS (
  SELECT p.id, p.name, p.slug, p.product_code, p.short_description, p.created_at,
    p.is_returnable, p.return_window_days, pt.vertical, b.id AS brand_id, b.name AS brand_name,
    c.id AS category_id, c.name AS category_name, c.slug AS category_slug,
    e.offer_id, e.variant_id, e.sku, e.sale_price, e.list_price, e.available_quantity,
    e.includes_tax, e.seller_name, e.minimum_order_quantity, e.quantity_step,
    (SELECT ma.file_key FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
      AND ma.tenant_id = p.tenant_id AND ma.deleted_at IS NULL WHERE pm.product_id = p.id
      ORDER BY pm.variant_id IS NOT NULL, pm.color_option_id IS NOT NULL,
        (pm.media_role = 'PRIMARY') DESC, pm.sort_order, pm.id LIMIT 1) AS image_url,
    (SELECT AVG(pr.rating) FROM product_ratings pr WHERE pr.tenant_id = p.tenant_id
      AND pr.product_id = p.id AND pr.status = 'PUBLISHED' AND pr.deleted_at IS NULL) AS rating,
    (SELECT COUNT(*) FROM product_ratings pr WHERE pr.tenant_id = p.tenant_id
      AND pr.product_id = p.id AND pr.status = 'PUBLISHED' AND pr.deleted_at IS NULL) AS review_count,
    (SELECT pav.value_text FROM product_attribute_values pav JOIN attribute_definitions ad ON ad.id = pav.attribute_id
      WHERE pav.product_id = p.id AND pav.tenant_id = p.tenant_id AND ad.code = 'CUSTOM_STOREFRONT_BADGE'
        AND ad.deleted_at IS NULL LIMIT 1) AS badge
  FROM products p JOIN ranked e ON e.product_id = p.id AND e.position = 1
  JOIN product_types pt ON pt.id = p.product_type_id
  LEFT JOIN brands b ON b.id = p.brand_id AND b.status = 'ACTIVE' AND b.deleted_at IS NULL
  JOIN categories c ON c.id = (SELECT pc.category_id FROM product_categories pc
    JOIN categories cat ON cat.id = pc.category_id AND cat.tenant_id = p.tenant_id
      AND cat.status = 'ACTIVE' AND cat.deleted_at IS NULL WHERE pc.product_id = p.id
    ORDER BY pc.is_primary DESC, pc.category_id LIMIT 1)
)`;

const scopeParams = (scope) => [scope.currency, uuidToBuffer(scope.tenantId), uuidToBuffer(scope.storeId)];
export function mapProduct(row, currency) {
  return { id: bufferToUuid(row.id), slug: row.slug, productCode: row.product_code, name: row.name,
    brandId: bufferToUuid(row.brand_id), brand: row.brand_name || "", categoryId: bufferToUuid(row.category_id),
    category: row.category_name, categorySlug: row.category_slug, vertical: row.vertical,
    price: Number(row.sale_price), mrp: Number(row.list_price), currency,
    image: row.image_url || "", tag: row.badge || "", color: "#ece9e2",
    rating: row.rating === null ? "0" : Number(row.rating).toFixed(1), reviews: Number(row.review_count),
    availableQuantity: Number(row.available_quantity), inStock: Number(row.available_quantity) >= Number(row.minimum_order_quantity),
    offerId: bufferToUuid(row.offer_id), variantId: bufferToUuid(row.variant_id), sku: row.sku,
    minimumOrderQuantity: Number(row.minimum_order_quantity), quantityStep: Number(row.quantity_step),
    description: row.short_description || "", sellerName: row.seller_name,
    includesTax: Boolean(row.includes_tax), isReturnable: Boolean(row.is_returnable),
    returnWindowDays: Number(row.return_window_days || 0) };
}

export async function listProducts({ scope, filters, connection = getPrimaryPool() }) {
  const where = ["1 = 1"]; const values = [];
  if (filters.search) { where.push("(name LIKE ? ESCAPE '\\\\' OR product_code LIKE ? ESCAPE '\\\\' OR brand_name LIKE ? ESCAPE '\\\\' OR category_name LIKE ? ESCAPE '\\\\' OR sku LIKE ? ESCAPE '\\\\')");
    const term = `%${filters.search.replace(/[\\%_]/g, "\\$&")}%`; values.push(term, term, term, term, term); }
  if (filters.category) { where.push("category_slug = ?"); values.push(filters.category); }
  if (filters.brand) { where.push("brand_id = ?"); values.push(uuidToBuffer(filters.brand)); }
  if (filters.minPrice !== undefined) { where.push("sale_price >= ?"); values.push(filters.minPrice); }
  if (filters.maxPrice !== undefined) { where.push("sale_price <= ?"); values.push(filters.maxPrice); }
  if (filters.minRating) { where.push("rating >= ?"); values.push(filters.minRating); }
  if (filters.inStock) where.push("available_quantity >= minimum_order_quantity");
  if (filters.minDiscount) { where.push("(list_price - sale_price) / NULLIF(list_price, 0) * 100 >= ?"); values.push(filters.minDiscount); }
  const orders = { featured: "product_code, id", newest: "created_at DESC, id DESC",
    price_asc: "sale_price, id", price_desc: "sale_price DESC, id", rating: "rating DESC, review_count DESC, id",
    discount: "(list_price - sale_price) / NULLIF(list_price, 0) DESC, id", review_count: "review_count DESC, rating DESC, id" };
  const clause = where.join(" AND "); const params = [...scopeParams(scope), ...values];
  // MariaDB 10.4 can fail when reusing prepared recursive CTEs with scalar aggregates.
  // mysql2 query placeholders still escape/bind all user values; only allowlisted sort SQL is interpolated.
  const [[rows], [[count]]] = await Promise.all([
    connection.query(`${offersCte} SELECT * FROM catalog WHERE ${clause} ORDER BY ${orders[filters.sort] || orders.featured} LIMIT ? OFFSET ?`,
      [...params, filters.pageSize, (filters.page - 1) * filters.pageSize]),
    connection.query(`${offersCte} SELECT COUNT(*) AS total FROM catalog WHERE ${clause}`, params)
  ]);
  return { items: rows.map((row) => mapProduct(row, scope.currency)), total: Number(count.total),
    page: filters.page, pageSize: filters.pageSize, totalPages: Math.max(1, Math.ceil(Number(count.total) / filters.pageSize)) };
}

export async function listFacets({ scope, connection = getPrimaryPool() }) {
  const [[categories], [brands]] = await Promise.all([
    connection.query(`${offersCte} SELECT category_id, category_name, category_slug,
      MIN(image_url) AS image_url, COUNT(*) AS product_count FROM catalog
      GROUP BY category_id, category_name, category_slug ORDER BY category_name`, scopeParams(scope)),
    connection.query(`${offersCte} SELECT brand_id, brand_name, COUNT(*) AS product_count FROM catalog
      WHERE brand_id IS NOT NULL GROUP BY brand_id, brand_name ORDER BY brand_name`, scopeParams(scope))
  ]);
  return { categories: categories.map((row) => ({ id: bufferToUuid(row.category_id), name: row.category_name,
    slug: row.category_slug, image: row.image_url || "", subtitle: `Explore ${row.category_name}`, color: "#ece9e2", count: Number(row.product_count) })),
  brands: brands.map((row) => ({ id: bufferToUuid(row.brand_id), name: row.brand_name, count: Number(row.product_count) })) };
}

export async function findProduct({ scope, slug, connection = getPrimaryPool() }) {
  const [rows] = await connection.query(`${offersCte} SELECT * FROM catalog WHERE slug = ? LIMIT 1`, [...scopeParams(scope), slug]);
  return rows[0] ? mapProduct(rows[0], scope.currency) : null;
}

// Reuse the public catalogue guards: never expose hidden/foreign products through a wishlist.
export async function wishlistProducts({ scope, productIds, connection = getPrimaryPool() }) {
  if (!productIds.length) return [];
  const [rows] = await connection.query(`${offersCte} SELECT * FROM catalog WHERE id IN (${productIds.map(() => "?").join(",")})`,
    [...scopeParams(scope), ...productIds.map(uuidToBuffer)]);
  return rows.map((row) => mapProduct(row, scope.currency));
}

export async function listVariants({ scope, productId, connection = getPrimaryPool() }) {
  const [rows] = await connection.query(`${offersCte} SELECT e.*,
    (SELECT ao.id FROM variant_attribute_values v JOIN attribute_definitions ad ON ad.id = v.attribute_id AND ad.code = 'COLOR'
      JOIN attribute_options ao ON ao.id = v.option_id WHERE v.variant_id = e.variant_id LIMIT 1) AS color_id,
    (SELECT ao.display_label FROM variant_attribute_values v JOIN attribute_definitions ad ON ad.id = v.attribute_id AND ad.code = 'COLOR'
      JOIN attribute_options ao ON ao.id = v.option_id WHERE v.variant_id = e.variant_id LIMIT 1) AS color_name,
    (SELECT ao.display_label FROM variant_attribute_values v JOIN attribute_definitions ad ON ad.id = v.attribute_id AND ad.code = 'SIZE'
      JOIN attribute_options ao ON ao.id = v.option_id WHERE v.variant_id = e.variant_id LIMIT 1) AS size_name
    FROM sellable e WHERE e.product_id = ? ORDER BY e.sale_price, e.offer_id`, [...scopeParams(scope), uuidToBuffer(productId)]);
  return rows.map((row) => ({ id: bufferToUuid(row.variant_id), offerId: bufferToUuid(row.offer_id),
    name: row.variant_name || "Standard", sku: row.sku, colorId: bufferToUuid(row.color_id),
    color: row.color_name || "", size: row.size_name || "", price: Number(row.sale_price), mrp: Number(row.list_price),
    sellerName: row.seller_name, availableQuantity: Number(row.available_quantity),
    minimumOrderQuantity: Number(row.minimum_order_quantity), maximumOrderQuantity: row.maximum_order_quantity === null ? null : Number(row.maximum_order_quantity),
    quantityStep: Number(row.quantity_step), soldByWeight: Boolean(row.sold_by_weight), uom: row.uom,
    warrantyMonths: Number(row.warranty_months || 0), warrantyType: row.warranty_type }));
}

// Exact seller/variant offers, not the representative offer used by catalog cards.
export async function cartOffers({ scope, offerIds, connection = getPrimaryPool() }) {
  if (!offerIds.length) return [];
  const [rows] = await connection.query(`${offersCte} SELECT c.*, e.*,
    (SELECT ma.file_key FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
      AND ma.tenant_id = e.tenant_id AND ma.deleted_at IS NULL
      WHERE pm.product_id = e.product_id AND (pm.variant_id IS NULL OR pm.variant_id = e.variant_id)
      AND (pm.color_option_id IS NULL OR pm.color_option_id IN
        (SELECT v.option_id FROM variant_attribute_values v JOIN attribute_definitions ad ON ad.id = v.attribute_id
         AND ad.code = 'COLOR' WHERE v.variant_id = e.variant_id))
      ORDER BY (pm.variant_id IS NOT NULL) DESC, (pm.color_option_id IS NOT NULL) DESC,
        (pm.media_role = 'PRIMARY') DESC, pm.sort_order, pm.id LIMIT 1) AS image_url
    FROM sellable e JOIN catalog c ON c.id = e.product_id
    WHERE e.offer_id IN (${offerIds.map(() => "?").join(",")})`, [...scopeParams(scope), ...offerIds.map(uuidToBuffer)]);
  return rows.map((row) => ({ ...mapProduct(row, scope.currency), variantName: row.variant_name,
    maximumOrderQuantity: row.maximum_order_quantity === null ? null : Number(row.maximum_order_quantity),
    soldByWeight: Boolean(row.sold_by_weight), uom: row.uom }));
}

export async function listReviews({ scope, productId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT id, rating, title, review_text, verified_purchase,
    customer_name_snapshot, submitted_at FROM product_ratings
    WHERE tenant_id = ? AND product_id = ? AND status = 'PUBLISHED' AND deleted_at IS NULL
    ORDER BY helpful_count DESC, submitted_at DESC, id LIMIT 20`, [uuidToBuffer(scope.tenantId), uuidToBuffer(productId)]);
  return rows.map((row) => ({ id: bufferToUuid(row.id), rating: Number(row.rating), title: row.title || "",
    body: row.review_text || "", name: row.customer_name_snapshot?.split(/\s+/)[0] || "Customer",
    verifiedPurchase: Boolean(row.verified_purchase), date: row.submitted_at }));
}
