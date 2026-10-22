import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

const number = (value) => value === null || value === undefined ? null : Number(value);
const iso = (value) => value instanceof Date ? value.toISOString() : value;
const escapeSearch = (value) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

function mapOffer(row) {
  return {
    id: bufferToUuid(row.id), merchantId: bufferToUuid(row.merchant_id), merchantName: row.merchant_name,
    merchantCode: row.merchant_code, merchantType: row.merchant_type, merchantStatus: row.merchant_status,
    storeId: bufferToUuid(row.store_id),
    storeName: row.store_name, variantId: bufferToUuid(row.variant_id), productName: row.product_name,
    variantName: row.variant_name, catalogSku: row.catalog_sku, sellerSku: row.seller_sku,
    vertical: row.vertical, status: row.status, fulfillmentType: row.fulfillment_type,
    handlingTimeHours: Number(row.handling_time_hours || 0), minimumOrderQuantity: number(row.minimum_order_quantity),
    maximumOrderQuantity: number(row.maximum_order_quantity), priceListId: bufferToUuid(row.price_list_id),
    priceListName: row.price_list_name, priceListCode: row.price_list_code, currency: row.currency || "INR",
    listPrice: number(row.list_price), salePrice: number(row.sale_price), costPrice: number(row.cost_price),
    availableQuantity: number(row.available_quantity) || 0, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function mapPriceList(row) {
  return {
    id: bufferToUuid(row.id), storeId: bufferToUuid(row.store_id), storeName: row.store_name || "All stores",
    code: row.code, name: row.name, currency: row.currency, includesTax: Boolean(row.includes_tax),
    priority: Number(row.priority || 0), startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), status: row.status,
    offerCount: Number(row.offer_count || 0), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

const offerSelect = `SELECT so.*, m.display_name AS merchant_name, m.merchant_code, m.merchant_type,
  m.status AS merchant_status,
  s.name AS store_name, pv.sku AS catalog_sku, pv.name AS variant_name, p.name AS product_name,
  pt.vertical, price.id AS price_id, price.price_list_id, price.list_price, price.sale_price,
  price.cost_price, pl.name AS price_list_name, pl.code AS price_list_code, pl.currency,
  COALESCE((SELECT SUM(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity)
    FROM inventory_balances ib WHERE ib.offer_id = so.id), 0) AS available_quantity
  FROM seller_offers so
  JOIN merchants m ON m.id = so.merchant_id
  JOIN stores s ON s.id = so.store_id
  JOIN product_variants pv ON pv.id = so.variant_id
  JOIN products p ON p.id = pv.product_id
  JOIN product_types pt ON pt.id = p.product_type_id
  LEFT JOIN offer_prices price ON price.id = (SELECT current_price.id FROM offer_prices current_price
    WHERE current_price.offer_id = so.id AND current_price.ends_at IS NULL
    ORDER BY current_price.starts_at DESC, current_price.created_at DESC LIMIT 1)
  LEFT JOIN price_lists pl ON pl.id = price.price_list_id`;

export async function listOffers({ tenantId, filters, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId); const where = ["so.tenant_id = ?", "so.deleted_at IS NULL"];
  const params = [tenant];
  if (filters.search) {
    const term = `%${escapeSearch(filters.search)}%`;
    where.push(`(p.name LIKE ? ESCAPE '\\\\' OR pv.name LIKE ? ESCAPE '\\\\' OR pv.sku LIKE ? ESCAPE '\\\\'
      OR so.seller_sku LIKE ? ESCAPE '\\\\' OR m.display_name LIKE ? ESCAPE '\\\\')`);
    params.push(term, term, term, term, term);
  }
  if (filters.status !== "ALL") { where.push("so.status = ?"); params.push(filters.status); }
  if (filters.merchantType !== "ALL") { where.push("m.merchant_type = ?"); params.push(filters.merchantType); }
  if (filters.storeId) { where.push("so.store_id = ?"); params.push(uuidToBuffer(filters.storeId)); }
  const clause = where.join(" AND "); const offset = (filters.page - 1) * filters.pageSize;
  const [rowsResult, countResult, summaryResult] = await Promise.all([
    connection.execute(`${offerSelect} WHERE ${clause} ORDER BY so.updated_at DESC, so.created_at DESC LIMIT ? OFFSET ?`,
      [...params, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total FROM seller_offers so JOIN merchants m ON m.id = so.merchant_id
      JOIN product_variants pv ON pv.id = so.variant_id JOIN products p ON p.id = pv.product_id
      WHERE ${clause}`, params),
    connection.execute(`SELECT COUNT(*) AS total, SUM(so.status = 'ACTIVE') AS active,
      SUM(so.status = 'DRAFT') AS draft, SUM(so.status = 'INACTIVE') AS inactive,
      COUNT(DISTINCT so.merchant_id) AS merchants,
      COALESCE(SUM((SELECT SUM(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity)
        FROM inventory_balances ib WHERE ib.offer_id = so.id)), 0) AS available_units
      FROM seller_offers so WHERE so.tenant_id = ? AND so.deleted_at IS NULL`, [tenant])
  ]);
  const total = Number(countResult[0][0].total || 0); const summary = summaryResult[0][0];
  return { items: rowsResult[0].map(mapOffer), total, page: filters.page, pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)), summary: {
      total: Number(summary.total || 0), active: Number(summary.active || 0), draft: Number(summary.draft || 0),
      inactive: Number(summary.inactive || 0), merchants: Number(summary.merchants || 0),
      availableUnits: number(summary.available_units) || 0
    } };
}

export async function getOffer({ tenantId, offerId, connection = getPrimaryPool(), forUpdate = false }) {
  const [rows] = await connection.execute(`${offerSelect} WHERE so.tenant_id = ? AND so.id = ?
    AND so.deleted_at IS NULL LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
  [uuidToBuffer(tenantId), uuidToBuffer(offerId)]);
  return rows[0] ? mapOffer(rows[0]) : null;
}

export async function listOptions({ tenantId, variantSearch = "", connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId); const variantParams = [tenant];
  let variantClause = "";
  if (variantSearch) {
    const term = `%${escapeSearch(variantSearch)}%`; variantClause = `AND (p.name LIKE ? ESCAPE '\\\\'
      OR pv.name LIKE ? ESCAPE '\\\\' OR pv.sku LIKE ? ESCAPE '\\\\')`; variantParams.push(term, term, term);
  }
  const [merchantRows, variantRows, priceListRows] = await Promise.all([
    connection.execute(`SELECT m.id, m.merchant_code, m.display_name, m.merchant_type, m.status,
      s.id AS store_id, s.code AS store_code, s.name AS store_name
      FROM merchants m JOIN store_merchants sm ON sm.merchant_id = m.id AND sm.status = 'ACTIVE'
      JOIN stores s ON s.id = sm.store_id AND s.status = 'ACTIVE' AND s.deleted_at IS NULL
      WHERE m.tenant_id = ? AND m.status = 'ACTIVE' AND m.deleted_at IS NULL
      ORDER BY m.merchant_type, m.display_name, s.name`, [tenant]),
    connection.execute(`SELECT pv.id, pv.sku, pv.name AS variant_name, p.name AS product_name, pt.vertical
      FROM product_variants pv JOIN products p ON p.id = pv.product_id
      JOIN product_types pt ON pt.id = p.product_type_id
      WHERE pv.tenant_id = ? AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL AND p.deleted_at IS NULL
      ${variantClause} ORDER BY p.name, pv.name LIMIT 150`, variantParams),
    connection.execute(`SELECT pl.*, s.name AS store_name,
      (SELECT COUNT(*) FROM offer_prices op WHERE op.price_list_id = pl.id AND op.ends_at IS NULL) AS offer_count
      FROM price_lists pl LEFT JOIN stores s ON s.id = pl.store_id
      WHERE pl.tenant_id = ? AND pl.status = 'ACTIVE' ORDER BY pl.priority DESC, pl.name`, [tenant])
  ]);
  const merchants = new Map();
  for (const row of merchantRows[0]) {
    const id = bufferToUuid(row.id);
    if (!merchants.has(id)) merchants.set(id, { id, code: row.merchant_code, name: row.display_name,
      type: row.merchant_type, status: row.status, stores: [] });
    merchants.get(id).stores.push({ id: bufferToUuid(row.store_id), code: row.store_code, name: row.store_name });
  }
  return { merchants: [...merchants.values()], variants: variantRows[0].map((row) => ({
    id: bufferToUuid(row.id), sku: row.sku, variantName: row.variant_name,
    productName: row.product_name, vertical: row.vertical })), priceLists: priceListRows[0].map(mapPriceList) };
}

export async function listPriceLists({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT pl.*, s.name AS store_name,
    (SELECT COUNT(*) FROM offer_prices op WHERE op.price_list_id = pl.id AND op.ends_at IS NULL) AS offer_count
    FROM price_lists pl LEFT JOIN stores s ON s.id = pl.store_id
    WHERE pl.tenant_id = ? ORDER BY pl.priority DESC, pl.name`, [uuidToBuffer(tenantId)]);
  return rows.map(mapPriceList);
}

export async function findOfferContext({ tenantId, merchantId, storeId, variantId, priceListId, connection }) {
  const [rows] = await connection.execute(`SELECT m.status AS merchant_status, m.merchant_type,
    p.tax_category_id, pl.status AS price_list_status, pl.store_id AS price_list_store_id
    FROM merchants m
    JOIN store_merchants sm ON sm.merchant_id = m.id AND sm.store_id = ? AND sm.status = 'ACTIVE'
    JOIN stores s ON s.id = sm.store_id AND s.tenant_id = m.tenant_id AND s.status = 'ACTIVE' AND s.deleted_at IS NULL
    JOIN product_variants pv ON pv.id = ? AND pv.tenant_id = m.tenant_id AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL
    JOIN products p ON p.id = pv.product_id AND p.deleted_at IS NULL
    JOIN price_lists pl ON pl.id = ? AND pl.tenant_id = m.tenant_id
    WHERE m.tenant_id = ? AND m.id = ? AND m.deleted_at IS NULL LIMIT 1 FOR UPDATE`,
  [uuidToBuffer(storeId), uuidToBuffer(variantId), uuidToBuffer(priceListId), uuidToBuffer(tenantId), uuidToBuffer(merchantId)]);
  if (!rows[0]) return null;
  return { merchantStatus: rows[0].merchant_status, merchantType: rows[0].merchant_type,
    taxCategoryId: bufferToUuid(rows[0].tax_category_id), priceListStatus: rows[0].price_list_status,
    priceListStoreId: bufferToUuid(rows[0].price_list_store_id) };
}

export async function findDuplicateOffer({ storeId, merchantId, variantId, sellerSku, excludeOfferId = null, connection }) {
  const params = [uuidToBuffer(storeId), uuidToBuffer(merchantId), uuidToBuffer(variantId), sellerSku];
  let exclude = "";
  if (excludeOfferId) { exclude = "AND id <> ?"; params.push(uuidToBuffer(excludeOfferId)); }
  const [rows] = await connection.execute(`SELECT id FROM seller_offers WHERE store_id = ? AND merchant_id = ?
    AND deleted_at IS NULL AND (variant_id = ? OR seller_sku = ?) ${exclude} LIMIT 1`, params);
  return rows[0] ? bufferToUuid(rows[0].id) : null;
}

export async function insertOffer({ offer, connection }) {
  await connection.execute(`INSERT INTO seller_offers (id, tenant_id, store_id, merchant_id, variant_id, seller_sku,
    status, fulfillment_type, handling_time_hours, minimum_order_quantity, maximum_order_quantity,
    tax_category_id, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    CASE WHEN ? = 'ACTIVE' THEN ? ELSE NULL END, CASE WHEN ? = 'ACTIVE' THEN UTC_TIMESTAMP(6) ELSE NULL END)`,
  [uuidToBuffer(offer.id), uuidToBuffer(offer.tenantId), uuidToBuffer(offer.storeId), uuidToBuffer(offer.merchantId),
    uuidToBuffer(offer.variantId), offer.sellerSku, offer.status, offer.fulfillmentType, offer.handlingTimeHours,
    offer.minimumOrderQuantity, offer.maximumOrderQuantity, offer.taxCategoryId ? uuidToBuffer(offer.taxCategoryId) : null,
    offer.status, uuidToBuffer(offer.actorUserId), offer.status]);
}

export async function updateOffer({ offerId, changes, actorUserId, connection }) {
  await connection.execute(`UPDATE seller_offers SET status = COALESCE(?, status),
    fulfillment_type = COALESCE(?, fulfillment_type), handling_time_hours = COALESCE(?, handling_time_hours),
    minimum_order_quantity = ?, maximum_order_quantity = ?, approved_by = CASE WHEN ? = 'ACTIVE' THEN ? ELSE approved_by END,
    approved_at = CASE WHEN ? = 'ACTIVE' THEN COALESCE(approved_at, UTC_TIMESTAMP(6)) ELSE approved_at END WHERE id = ?`,
  [changes.status ?? null, changes.fulfillmentType ?? null, changes.handlingTimeHours ?? null,
    changes.minimumOrderQuantity, changes.maximumOrderQuantity, changes.status ?? null, uuidToBuffer(actorUserId),
    changes.status ?? null, uuidToBuffer(offerId)]);
}

export async function closeOfferPrices({ offerId, connection }) {
  await connection.execute("UPDATE offer_prices SET ends_at = UTC_TIMESTAMP(6) WHERE offer_id = ? AND ends_at IS NULL",
    [uuidToBuffer(offerId)]);
}

export async function insertOfferPrice({ price, connection }) {
  await connection.execute(`INSERT INTO offer_prices (id, tenant_id, offer_id, price_list_id, list_price,
    sale_price, cost_price, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), NULL)`,
  [uuidToBuffer(price.id), uuidToBuffer(price.tenantId), uuidToBuffer(price.offerId), uuidToBuffer(price.priceListId),
    price.listPrice, price.salePrice, price.costPrice]);
}

export async function storeExists({ tenantId, storeId, connection }) {
  if (!storeId) return true;
  const [rows] = await connection.execute(`SELECT id FROM stores WHERE tenant_id = ? AND id = ?
    AND status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1`, [uuidToBuffer(tenantId), uuidToBuffer(storeId)]);
  return Boolean(rows[0]);
}

export async function findPriceList({ tenantId, priceListId, connection = getPrimaryPool(), forUpdate = false }) {
  const [rows] = await connection.execute(`SELECT pl.*, s.name AS store_name,
    (SELECT COUNT(*) FROM offer_prices op WHERE op.price_list_id = pl.id AND op.ends_at IS NULL) AS offer_count
    FROM price_lists pl LEFT JOIN stores s ON s.id = pl.store_id WHERE pl.tenant_id = ? AND pl.id = ?
    LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`, [uuidToBuffer(tenantId), uuidToBuffer(priceListId)]);
  return rows[0] ? mapPriceList(rows[0]) : null;
}

export async function insertPriceList({ priceList, connection }) {
  await connection.execute(`INSERT INTO price_lists (id, tenant_id, store_id, code, name, currency,
    includes_tax, priority, starts_at, ends_at, status) VALUES (?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?)`,
  [uuidToBuffer(priceList.id), uuidToBuffer(priceList.tenantId), priceList.storeId ? uuidToBuffer(priceList.storeId) : null,
    priceList.code, priceList.name, priceList.includesTax ? 1 : 0, priceList.priority,
    priceList.startsAt, priceList.endsAt, priceList.status]);
}

export async function updatePriceList({ priceListId, input, connection }) {
  await connection.execute(`UPDATE price_lists SET store_id = ?, code = ?, name = ?, includes_tax = ?,
    priority = ?, starts_at = ?, ends_at = ?, status = ? WHERE id = ?`,
  [input.storeId ? uuidToBuffer(input.storeId) : null, input.code, input.name, input.includesTax ? 1 : 0,
    input.priority, input.startsAt, input.endsAt, input.status, uuidToBuffer(priceListId)]);
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action,
    entity_type, entity_id, request_id, ip_address, user_agent, before_data, after_data)
    VALUES (?, ?, ?, 'USER', ?, ?, ?, ?, INET6_ATON(?), ?, ?, ?)`,
  [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId), audit.action,
    audit.entityType, uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress, audit.userAgent,
    JSON.stringify(audit.beforeData), JSON.stringify(audit.afterData)]);
}
