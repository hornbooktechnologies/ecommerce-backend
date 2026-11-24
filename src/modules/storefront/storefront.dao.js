import {specificationPredicate,listSpecificationFacets} from './specification-filters.dao.js';
import { qualifiesForFreeDelivery } from "./free-delivery.js";
import { getPrimaryPool } from "../../database/pool-factory.js";
import {summaries as sellerRatingSummaries} from '../seller-ratings/seller-ratings.dao.js';
import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import {publicPhotos} from '../review-photos/review-photos.dao.js';

// Every public query starts from an active tenant/store and eligible, dated offers.
export async function resolveStore({ tenantCode, storeCode, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT t.id AS tenant_id, t.display_name,
    s.id AS store_id, s.name, s.code, s.base_currency, s.support_email, s.support_phone FROM tenants t
    JOIN stores s ON s.tenant_id = t.id AND s.status = 'ACTIVE' AND s.deleted_at IS NULL
    WHERE t.code = ? AND t.status = 'ACTIVE' AND t.deleted_at IS NULL AND s.code = ? LIMIT 1`,
  [tenantCode, storeCode]);
  const row = rows[0];
  return row ? { tenantId: bufferToUuid(row.tenant_id), storeId: bufferToUuid(row.store_id),
    tenantName: row.display_name, name: row.name, code: row.code, currency: row.base_currency,
    supportEmail: row.support_email || null, supportPhone: row.support_phone || null } : null;
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

// Used by both storefront eligibility and the admin explanation for missing prices.
const currentPriceId = `SELECT current_price.id FROM offer_prices current_price
    JOIN price_lists current_list ON current_list.id = current_price.price_list_id
      AND current_list.tenant_id = so.tenant_id AND current_list.status = 'ACTIVE'
      AND current_list.currency = ? AND current_list.code = 'DEFAULT_INR'
      AND (current_list.starts_at IS NULL OR current_list.starts_at <= UTC_TIMESTAMP(6))
      AND (current_list.ends_at IS NULL OR current_list.ends_at > UTC_TIMESTAMP(6))
      AND (current_list.store_id IS NULL OR current_list.store_id = so.store_id)
    WHERE current_price.offer_id = so.id AND current_price.tenant_id = so.tenant_id
      AND (current_price.starts_at IS NULL OR current_price.starts_at <= UTC_TIMESTAMP(6))
      AND (current_price.ends_at IS NULL OR current_price.ends_at > UTC_TIMESTAMP(6))
    ORDER BY current_price.starts_at DESC, current_price.id DESC LIMIT 1`;

// Only internal, parameterised predicates may be passed here, never raw user SQL.
const offersCte = (offerPredicate = "1 = 1") => `WITH RECURSIVE eligible AS (
  SELECT so.id AS offer_id, so.tenant_id, so.merchant_id, pv.id AS variant_id, p.id AS product_id,
    p.free_delivery, delivery_tenant.free_delivery_above_inr, so.handling_time_hours, p.product_kind, pv.sku, pv.name AS variant_name, COALESCE(so.minimum_order_quantity, pv.minimum_order_quantity) AS minimum_order_quantity,
    COALESCE(so.maximum_order_quantity, pv.maximum_order_quantity) AS maximum_order_quantity, pv.quantity_step, pv.sold_by_weight, pv.warranty_months,
    pv.warranty_type, m.display_name AS seller_name, op.sale_price, op.list_price,
    pl.includes_tax, u.code AS uom, ${stock} AS raw_stock
  FROM seller_offers so
  JOIN product_variants pv ON pv.id = so.variant_id AND pv.tenant_id = so.tenant_id
    AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL
  JOIN products p ON p.id = pv.product_id AND p.tenant_id = so.tenant_id
    AND p.publication_status = 'PUBLISHED' AND p.approval_status = 'APPROVED' AND p.deleted_at IS NULL
  JOIN product_types pt ON pt.id = p.product_type_id AND pt.tenant_id = p.tenant_id AND pt.deleted_at IS NULL
  JOIN tenants delivery_tenant ON delivery_tenant.id = p.tenant_id
  JOIN tenant_product_verticals tpv ON tpv.tenant_id = p.tenant_id AND tpv.vertical = pt.vertical AND tpv.status = 'ACTIVE'
  JOIN merchants m ON m.id = so.merchant_id AND m.tenant_id = so.tenant_id AND m.deleted_at IS NULL
    AND m.status = 'ACTIVE'
    AND (m.merchant_type = 'FIRST_PARTY' OR (m.merchant_type = 'VENDOR' AND EXISTS (
      SELECT 1 FROM vendor_profiles vp WHERE vp.merchant_id = m.id AND vp.tenant_id = m.tenant_id
        AND vp.onboarding_status = 'APPROVED')))
  JOIN store_merchants sm ON sm.store_id = so.store_id AND sm.merchant_id = so.merchant_id AND sm.status = 'ACTIVE'
  JOIN units_of_measure u ON u.id = pv.selling_uom_id
  JOIN offer_prices op ON op.id = (${currentPriceId})
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
  FROM sellable e WHERE ${offerPredicate}
), catalog AS (
  SELECT p.id, p.name, p.slug, p.product_code, p.short_description, p.created_at,
    p.is_returnable, p.return_window_days, pt.vertical, b.id AS brand_id, b.name AS brand_name,
    c.id AS category_id, c.name AS category_name, c.slug AS category_slug,
    e.free_delivery, e.free_delivery_above_inr, e.offer_id, e.variant_id, e.sku, e.sale_price, e.list_price, e.available_quantity,
    (SELECT ao.display_label FROM variant_attribute_values v JOIN attribute_definitions ad ON ad.id = v.attribute_id AND ad.code = 'COLOR'
      JOIN attribute_options ao ON ao.id = v.option_id WHERE v.variant_id = e.variant_id LIMIT 1) AS matched_color,
    (SELECT ao.display_label FROM variant_attribute_values v JOIN attribute_definitions ad ON ad.id = v.attribute_id AND ad.code = 'SIZE'
      JOIN attribute_options ao ON ao.id = v.option_id WHERE v.variant_id = e.variant_id LIMIT 1) AS matched_size,
    e.includes_tax, e.seller_name, e.minimum_order_quantity, e.quantity_step,
    (SELECT ma.file_key FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
      AND ma.tenant_id = p.tenant_id AND ma.deleted_at IS NULL WHERE pm.product_id = p.id
      AND (pm.variant_id IS NULL OR pm.variant_id = e.variant_id)
      AND (pm.color_option_id IS NULL OR EXISTS (SELECT 1 FROM variant_attribute_values v WHERE v.variant_id = e.variant_id AND v.option_id = pm.color_option_id))
      ORDER BY pm.variant_id IS NOT NULL DESC, pm.color_option_id IS NOT NULL DESC,
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

export async function readinessStores({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT id, name, base_currency FROM stores
    WHERE tenant_id=? AND status='ACTIVE' AND deleted_at IS NULL ORDER BY created_at,id`, [uuidToBuffer(tenantId)]);
  return rows.map(row => ({id:bufferToUuid(row.id), name:row.name, currency:row.base_currency}));
}

// Start from every SKU, not just the offers that survived storefront eligibility.
export async function readinessRows({scope, productId, connection = getPrimaryPool()}) {
  const [rows] = await connection.query(`${offersCte()} SELECT pv.sku, pv.name, pv.status AS variant_status,
    so.id AS offer_id, so.status AS offer_status, m.display_name, m.merchant_type,
    op.sale_price, e.available_quantity, e.minimum_order_quantity, e.maximum_order_quantity
    FROM product_variants pv
    LEFT JOIN seller_offers so ON so.variant_id=pv.id AND so.tenant_id=pv.tenant_id AND so.store_id=? AND so.deleted_at IS NULL
    LEFT JOIN merchants m ON m.id=so.merchant_id AND m.tenant_id=pv.tenant_id
    LEFT JOIN offer_prices op ON op.id=(${currentPriceId})
    LEFT JOIN sellable e ON e.offer_id=so.id
    WHERE pv.tenant_id=? AND pv.product_id=? AND pv.deleted_at IS NULL
    ORDER BY pv.sku,m.display_name,so.id`, [...scopeParams(scope),uuidToBuffer(scope.storeId),scope.currency,uuidToBuffer(scope.tenantId),uuidToBuffer(productId)]);
  return rows.map(row => ({
    sku:row.sku, variant:row.name, seller:row.display_name, merchantType:row.merchant_type,
    offerId:bufferToUuid(row.offer_id), activeVariant:row.variant_status==='ACTIVE', activeOffer:row.offer_status==='ACTIVE',
    price:row.sale_price==null?null:Number(row.sale_price), available:row.available_quantity==null?null:Number(row.available_quantity),
    minimum:row.minimum_order_quantity==null?null:Number(row.minimum_order_quantity),
    maximum:row.maximum_order_quantity==null?null:Number(row.maximum_order_quantity)
  }));
}
export function mapProduct(row, currency) {
  return { id: bufferToUuid(row.id), slug: row.slug, productCode: row.product_code, name: row.name,
    brandId: bufferToUuid(row.brand_id), brand: row.brand_name || "", categoryId: bufferToUuid(row.category_id),
    category: row.category_name, categorySlug: row.category_slug, vertical: row.vertical,
    price: Number(row.sale_price), mrp: Number(row.list_price), currency,
    image: row.image_url || "", tag: row.badge || "", color: "#ece9e2",
    rating: row.rating === null ? "0" : Number(row.rating).toFixed(1), reviews: Number(row.review_count),
    availableQuantity: Number(row.available_quantity), inStock: Number(row.available_quantity) >= Number(row.minimum_order_quantity),
    offerId: bufferToUuid(row.offer_id), variantId: bufferToUuid(row.variant_id), sku: row.sku,
    matchedColor: row.matched_color || "", matchedSize: row.matched_size || "",
    freeDelivery: qualifiesForFreeDelivery(row), handlingTimeHours: Number(row.handling_time_hours || 0), minimumOrderQuantity: Number(row.minimum_order_quantity), quantityStep: Number(row.quantity_step),
    description: row.short_description || "", sellerName: row.seller_name,
    includesTax: Boolean(row.includes_tax), isReturnable: Boolean(row.is_returnable),
    returnWindowDays: Number(row.return_window_days || 0) };
}

export async function listProducts({ scope, filters, connection = getPrimaryPool() }) {
  const where = ["1 = 1"]; const values = [];
  const offerWhere = ["1 = 1"], offerValues = [];
  if (filters.search) {
    const term = `%${filters.search.replace(/[\\%_]/g, "\\$&")}%`;
    offerWhere.push(`(e.sku LIKE ? ESCAPE '\\\\' OR EXISTS (SELECT 1 FROM products sp
      LEFT JOIN brands sb ON sb.id = sp.brand_id AND sb.status = 'ACTIVE' AND sb.deleted_at IS NULL
      WHERE sp.id = e.product_id AND (sp.name LIKE ? ESCAPE '\\\\' OR sp.product_code LIKE ? ESCAPE '\\\\' OR sb.name LIKE ? ESCAPE '\\\\'
      OR EXISTS (SELECT 1 FROM product_categories pc JOIN categories sc ON sc.id = pc.category_id AND sc.status = 'ACTIVE' AND sc.deleted_at IS NULL
        WHERE pc.product_id = sp.id AND sc.name LIKE ? ESCAPE '\\\\'))))`);
    offerValues.push(term, term, term, term, term);
  }
  if (filters.category) { where.push("category_slug = ?"); values.push(filters.category); }
  if(filters.productSlugs){if(!filters.productSlugs.length)where.push('1=0');else{where.push(`slug IN (${filters.productSlugs.map(()=>'?').join(',')})`);values.push(...filters.productSlugs);}}
  const brands = [...new Set([...(filters.brands || []), ...(filters.brand ? [filters.brand] : [])])];
  if (brands.length) { where.push(`brand_id IN (${brands.map(() => '?').join(',')})`); values.push(...brands.map(uuidToBuffer)); }
  for (const [key, code] of [["colors", "COLOR"], ["sizes", "SIZE"]]) {
    if (!filters[key]?.length) continue;
    offerWhere.push(`EXISTS (SELECT 1 FROM variant_attribute_values v JOIN attribute_definitions ad ON ad.id = v.attribute_id
      AND ad.tenant_id = e.tenant_id AND ad.code = ? AND ad.deleted_at IS NULL
      JOIN attribute_options ao ON ao.id = v.option_id AND ao.tenant_id = e.tenant_id AND ao.status = 'ACTIVE'
      WHERE v.variant_id = e.variant_id AND ao.id IN (${filters[key].map(() => '?').join(',')}))`);
    offerValues.push(code, ...filters[key].map(uuidToBuffer));
  }
  if (filters.minPrice !== undefined) { offerWhere.push("e.sale_price >= ?"); offerValues.push(filters.minPrice); }
  if (filters.maxPrice !== undefined) { offerWhere.push("e.sale_price <= ?"); offerValues.push(filters.maxPrice); }
  if (filters.minRating) { where.push("rating >= ?"); values.push(filters.minRating); }
  if (filters.inStock) offerWhere.push("LEAST(e.available_quantity, COALESCE(e.maximum_order_quantity, e.available_quantity)) >= e.minimum_order_quantity");
  if (filters.minDiscount) { offerWhere.push("(e.list_price - e.sale_price) / NULLIF(e.list_price, 0) * 100 >= ?"); offerValues.push(filters.minDiscount); }
  const orders = { featured: "product_code, id", newest: "created_at DESC, id DESC",
    price_asc: "sale_price, id", price_desc: "sale_price DESC, id", rating: "rating DESC, review_count DESC, id",
    discount: "(list_price - sale_price) / NULLIF(list_price, 0) DESC, id", review_count: "review_count DESC, rating DESC, id" };
  const specClause=specificationPredicate({scope,filters,values});if(specClause)where.push(specClause);
  const clause = where.join(" AND "); const params = [...scopeParams(scope), ...offerValues, ...values];
  const cte = offersCte(offerWhere.join(" AND "));
  const manualOrder=filters.sort==='manual'&&filters.productSlugOrder?.length?filters.productSlugOrder:null;
  const order=manualOrder?`FIELD(slug,${manualOrder.map(()=>'?').join(',')}),id`:orders[filters.sort]||orders.featured;
  // MariaDB 10.4 can fail when reusing prepared recursive CTEs with scalar aggregates.
  // mysql2 query placeholders still escape/bind all user values; only allowlisted sort SQL is interpolated.
  const [[rows], [[count]]] = await Promise.all([
    connection.query(`${cte} SELECT * FROM catalog WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, ...(manualOrder||[]), filters.pageSize, (filters.page - 1) * filters.pageSize]),
    connection.query(`${cte} SELECT COUNT(*) AS total FROM catalog WHERE ${clause}`, params)
  ]);
  return { items: rows.map((row) => mapProduct(row, scope.currency)), total: Number(count.total),
    page: filters.page, pageSize: filters.pageSize, totalPages: Math.max(1, Math.ceil(Number(count.total) / filters.pageSize)) };
}

export async function listFacets({ scope, connection = getPrimaryPool() }) {
  const [[categories], [brands]] = await Promise.all([
    connection.query(`${offersCte()} SELECT category_id, category_name, category_slug,
      MIN(image_url) AS image_url, COUNT(*) AS product_count FROM catalog
      GROUP BY category_id, category_name, category_slug ORDER BY category_name`, scopeParams(scope)),
    connection.query(`${offersCte()} SELECT brand_id, brand_name, COUNT(*) AS product_count FROM catalog
      WHERE brand_id IS NOT NULL GROUP BY brand_id, brand_name ORDER BY brand_name`, scopeParams(scope))
  ]);
  return { categories: categories.map((row) => ({ id: bufferToUuid(row.category_id), name: row.category_name,
    slug: row.category_slug, image: row.image_url || "", subtitle: `Explore ${row.category_name}`, color: "#ece9e2", count: Number(row.product_count) })),
  brands: brands.map((row) => ({ id: bufferToUuid(row.brand_id), name: row.brand_name, count: Number(row.product_count) })) };
}

// Facets describe the search/category collection BEFORE option/price selections.
// Counts are distinct public products, not seller offers or unused/private masters.
async function discoveryOptionRows({scope,products,connection}){
  const totals=new Map();
  for(let offset=0;offset<products.length;offset+=500){const batch=products.slice(offset,offset+500);
    const [rows]=await connection.query(`${offersCte()} SELECT ad.code,ao.id,ao.display_label,ao.swatch_value,ao.sort_order,COUNT(DISTINCT e.product_id) AS product_count
      FROM sellable e JOIN variant_attribute_values v ON v.variant_id=e.variant_id
      JOIN attribute_definitions ad ON ad.id=v.attribute_id AND ad.tenant_id=e.tenant_id AND ad.code IN ('COLOR','SIZE') AND ad.deleted_at IS NULL
      JOIN attribute_options ao ON ao.id=v.option_id AND ao.tenant_id=e.tenant_id AND ao.status='ACTIVE'
      WHERE e.product_id IN (${batch.map(()=>'?').join(',')})
      GROUP BY ad.code,ao.id,ao.display_label,ao.swatch_value,ao.sort_order`,[...scopeParams(scope),...batch.map(row=>row.id)]);
    for(const row of rows){const key=bufferToUuid(row.id),previous=totals.get(key);if(previous)previous.product_count+=Number(row.product_count);else totals.set(key,{...row,product_count:Number(row.product_count)});}
  }
  return [...totals.values()].sort((a,b)=>a.code.localeCompare(b.code)||Number(a.sort_order)-Number(b.sort_order)||a.display_label.localeCompare(b.display_label));
}
export async function listDiscoveryFacets({ scope, filters, connection = getPrimaryPool() }) {
  const where = ["1 = 1"], values = [];
  if (filters.category) { where.push("c.category_slug = ?"); values.push(filters.category); }
  if (filters.search) {
    where.push(`(c.name LIKE ? ESCAPE '\\\\' OR c.product_code LIKE ? ESCAPE '\\\\' OR c.brand_name LIKE ? ESCAPE '\\\\'
      OR c.category_name LIKE ? ESCAPE '\\\\' OR EXISTS (SELECT 1 FROM sellable se WHERE se.product_id = c.id AND se.sku LIKE ? ESCAPE '\\\\'))`);
    const term = `%${filters.search.replace(/[\\%_]/g, "\\$&")}%`; values.push(term, term, term, term, term);
  }
  const params = [...scopeParams(scope), ...values], clause = where.join(' AND ');
  const [[brands], [products]] = await Promise.all([
    connection.query(`${offersCte()} SELECT c.brand_id,c.brand_name,COUNT(DISTINCT c.id) AS product_count FROM catalog c
      WHERE ${clause} AND c.brand_id IS NOT NULL GROUP BY c.brand_id,c.brand_name ORDER BY c.brand_name`, params),
    // Keep specification joins outside the recursive CTE: MariaDB 10.4 can
    // repeatedly expand that joined plan, even behind a DISTINCT boundary.
    connection.query(`${offersCte()} SELECT c.id FROM catalog c WHERE ${clause}`,params)
  ]);
  const [options,specifications]=await Promise.all([discoveryOptionRows({scope,products,connection}),listSpecificationFacets({scope,products,connection})]);
  const mapOptions = (code) => options.filter((row) => row.code === code).map((row) => ({id:bufferToUuid(row.id),name:row.display_label,swatchValue:row.swatch_value || null,count:Number(row.product_count)}));
  return { brands:brands.map((row) => ({id:bufferToUuid(row.brand_id),name:row.brand_name,count:Number(row.product_count)})),
    colors:mapOptions('COLOR'),sizes:mapOptions('SIZE'),specifications,countScope:'SEARCH_CATEGORY' };
}

export async function findProduct({ scope, slug, connection = getPrimaryPool() }) {
  const [rows] = await connection.query(`${offersCte()} SELECT * FROM catalog WHERE slug = ? LIMIT 1`, [...scopeParams(scope), slug]);
  return rows[0] ? mapProduct(rows[0], scope.currency) : null;
}

// Rank within this merchant BEFORE selecting a product's representative offer.
// A cheaper offer from another seller must never replace the profile seller's offer.
export async function sellerProducts({scope,merchantId,filters,connection=getPrimaryPool()}){
 const where=['1=1'],values=[];
 if(filters.search){where.push('(LOCATE(?,c.name)>0 OR LOCATE(?,c.product_code)>0)');values.push(filters.search,filters.search);}
 const predicate=`e.merchant_id=?${filters.inStock?' AND LEAST(e.available_quantity,COALESCE(e.maximum_order_quantity,e.available_quantity))>=e.minimum_order_quantity':''}`;
 const cte=offersCte(predicate),params=[...scopeParams(scope),uuidToBuffer(merchantId),...values];const order={newest:'c.created_at DESC,c.id',price_asc:'c.sale_price,c.id',price_desc:'c.sale_price DESC,c.id'}[filters.sort];
 const [[rows],[[count]]]=await Promise.all([connection.query(`${cte} SELECT c.* FROM catalog c WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,[...params,filters.pageSize,(filters.page-1)*filters.pageSize]),connection.query(`${cte} SELECT COUNT(*) total FROM catalog c WHERE ${where.join(' AND ')}`,params)]);
 return {items:rows.map(row=>mapProduct(row,scope.currency)),total:Number(count.total),page:filters.page,pageSize:filters.pageSize,totalPages:Math.max(1,Math.ceil(Number(count.total)/filters.pageSize))};
}

// Rank only currently public, sellable offers. No random popularity or cross-store history.
export async function recommendedProducts({scope,seeds=[],excludeIds=[],connection=getPrimaryPool()}){
  const categories=[...new Set(seeds.map(p=>p.categoryId).filter(Boolean))],brands=[...new Set(seeds.map(p=>p.brandId).filter(Boolean))],verticals=[...new Set(seeds.map(p=>p.vertical).filter(Boolean))];
  const values=[];const match=(column,list,binary=false)=>{if(!list.length)return '0';values.push(...list.map(v=>binary?uuidToBuffer(v):v));return `${column} IN (${list.map(()=>'?').join(',')})`;};
  const category=match('c.category_id',categories,true),brand=match('c.brand_id',brands,true),vertical=match('c.vertical',verticals);
  const excluded=excludeIds.length?`AND c.id NOT IN (${excludeIds.map(()=>'?').join(',')})`:'';
  const [rows]=await connection.query(`${offersCte('LEAST(e.available_quantity,COALESCE(e.maximum_order_quantity,e.available_quantity))>=e.minimum_order_quantity')} SELECT c.*,(${category}) category_match,(${brand}) brand_match,(${vertical}) vertical_match FROM catalog c WHERE 1=1 ${excluded} ORDER BY (category_match*8+brand_match*4+vertical_match*2) DESC,c.rating DESC,c.review_count DESC,c.created_at DESC,c.id LIMIT 8`,[...scopeParams(scope),...values,...excludeIds.map(uuidToBuffer)]);
  return rows.map(row=>({...mapProduct(row,scope.currency),recommendationReason:row.category_match?'Similar category':row.brand_match?'From a brand you explored':row.vertical_match?'Related product type':'Available in this store'}));
}

// Reuse the public catalogue guards: never expose hidden/foreign products through a wishlist.
export async function wishlistProducts({ scope, productIds, connection = getPrimaryPool() }) {
  if (!productIds.length) return [];
  const [rows] = await connection.query(`${offersCte()} SELECT * FROM catalog WHERE id IN (${productIds.map(() => "?").join(",")})`,
    [...scopeParams(scope), ...productIds.map(uuidToBuffer)]);
  return rows.map((row) => mapProduct(row, scope.currency));
}

export async function listVariants({ scope, productId, connection = getPrimaryPool() }) {
  const [rows] = await connection.query(`${offersCte()} SELECT e.*,
    EXISTS(SELECT 1 FROM seller_public_profiles sp WHERE sp.tenant_id=e.tenant_id AND sp.store_id=? AND sp.merchant_id=e.merchant_id AND sp.is_visible=1 AND sp.published_content IS NOT NULL) seller_profile_visible,
    (SELECT ao.id FROM variant_attribute_values v JOIN attribute_definitions ad ON ad.id = v.attribute_id AND ad.code = 'COLOR'
      JOIN attribute_options ao ON ao.id = v.option_id WHERE v.variant_id = e.variant_id LIMIT 1) AS color_id,
    (SELECT ao.display_label FROM variant_attribute_values v JOIN attribute_definitions ad ON ad.id = v.attribute_id AND ad.code = 'COLOR'
      JOIN attribute_options ao ON ao.id = v.option_id WHERE v.variant_id = e.variant_id LIMIT 1) AS color_name,
    (SELECT ao.swatch_value FROM variant_attribute_values v JOIN attribute_definitions ad ON ad.id = v.attribute_id AND ad.code = 'COLOR'
      JOIN attribute_options ao ON ao.id = v.option_id WHERE v.variant_id = e.variant_id LIMIT 1) AS color_swatch,
    (SELECT ao.display_label FROM variant_attribute_values v JOIN attribute_definitions ad ON ad.id = v.attribute_id AND ad.code = 'SIZE'
      JOIN attribute_options ao ON ao.id = v.option_id WHERE v.variant_id = e.variant_id LIMIT 1) AS size_name
    FROM sellable e WHERE e.product_id = ? ORDER BY e.sale_price, e.offer_id`, [...scopeParams(scope),uuidToBuffer(scope.storeId),uuidToBuffer(productId)]);
  const sellerRatings=await sellerRatingSummaries({...scope,merchantIds:[...new Set(rows.map(row=>bufferToUuid(row.merchant_id)))],connection});
  return rows.map((row) => ({ id: bufferToUuid(row.variant_id), offerId: bufferToUuid(row.offer_id),
    name: row.variant_name || "Standard", sku: row.sku, colorId: bufferToUuid(row.color_id),
    color: row.color_name || "", colorSwatch: row.color_swatch || null,
    size: row.size_name || "", price: Number(row.sale_price), mrp: Number(row.list_price),
    sellerId: bufferToUuid(row.merchant_id), sellerName: row.seller_name, sellerProfileHref:row.seller_profile_visible?`/sellers/${bufferToUuid(row.merchant_id)}`:null, sellerRating:sellerRatings.get(bufferToUuid(row.merchant_id))||{count:0,average:null}, includesTax: Boolean(row.includes_tax),
    availableQuantity: Number(row.available_quantity),
    freeDelivery: qualifiesForFreeDelivery(row), handlingTimeHours: Number(row.handling_time_hours || 0), minimumOrderQuantity: Number(row.minimum_order_quantity), maximumOrderQuantity: row.maximum_order_quantity === null ? null : Number(row.maximum_order_quantity),
    quantityStep: Number(row.quantity_step), soldByWeight: Boolean(row.sold_by_weight), uom: row.uom,
    warrantyMonths: Number(row.warranty_months || 0), warrantyType: row.warranty_type }));
}

// Exact seller/variant offers, not the representative offer used by catalog cards.
export async function cartOffers({ scope, offerIds, connection = getPrimaryPool() }) {
  if (!offerIds.length) return [];
  const [rows] = await connection.query(`${offersCte()} SELECT c.*, e.*,
    COALESCE((SELECT ao.display_label FROM variant_attribute_values v
      JOIN attribute_definitions ad ON ad.id = v.attribute_id AND ad.tenant_id = e.tenant_id AND ad.code = 'COLOR'
      JOIN attribute_options ao ON ao.id = v.option_id AND ao.attribute_id = ad.id
      WHERE v.tenant_id = e.tenant_id AND v.variant_id = e.variant_id LIMIT 1), '') AS matched_color,
    COALESCE((SELECT ao.display_label FROM variant_attribute_values v
      JOIN attribute_definitions ad ON ad.id = v.attribute_id AND ad.tenant_id = e.tenant_id AND ad.code = 'SIZE'
      JOIN attribute_options ao ON ao.id = v.option_id AND ao.attribute_id = ad.id
      WHERE v.tenant_id = e.tenant_id AND v.variant_id = e.variant_id LIMIT 1), '') AS matched_size,
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
  const photos=await publicPhotos({scope,reviewIds:rows.map(row=>bufferToUuid(row.id)),connection});
  return rows.map((row) => ({ id: bufferToUuid(row.id), rating: Number(row.rating), title: row.title || "",
    body: row.review_text || "", name: row.customer_name_snapshot?.split(/\s+/)[0] || "Customer",
    verifiedPurchase: Boolean(row.verified_purchase), date: row.submitted_at,
    photos:photos.filter(photo=>photo.reviewId===bufferToUuid(row.id)).map(photo=>({id:photo.id,alt:photo.alt,width:photo.width,height:photo.height,url:`/api/review-photos/${photo.id}`})) }));
}
