import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

const number = (value) => value === null || value === undefined ? null : Number(value);
const iso = (value) => value instanceof Date ? value.toISOString() : value;
const escapeSearch = (value) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

function mapVendor(row) {
  return {
    id: bufferToUuid(row.id), merchantCode: row.merchant_code, displayName: row.display_name,
    legalName: row.legal_name, logoUrl: row.logo_url || null, status: row.status, pan: row.pan,
    supportEmail: row.support_email,
    supportPhone: row.support_phone, approvedAt: iso(row.approved_at), createdAt: iso(row.created_at),
    onboardingStatus: row.onboarding_status, businessType: row.business_type,
    contactPerson: row.contact_person, defaultCommissionPercent: number(row.default_commission_rate) === null
      ? null : number(row.default_commission_rate) * 100,
    settlementCycleDays: Number(row.settlement_cycle_days || 0), notes: row.notes || "",
    gstin: row.gstin || null, address: row.line1 ? { line1: row.line1, line2: row.line2 || "",
      city: row.city, district: row.district || "", stateCode: row.state_code,
      stateName: row.state_name, postalCode: row.postal_code, countryCode: row.country_code } : null,
    storeCount: Number(row.store_count || 0), offerCount: Number(row.offer_count || 0),
    activeOfferCount: Number(row.active_offer_count || 0), productCount: Number(row.product_count || 0),
    orderCount: Number(row.order_count || 0), grossSales: number(row.gross_sales) || 0,
    availableUnits: number(row.available_units) || 0
  };
}

function mapOffer(row) {
  return {
    id: bufferToUuid(row.id), storeId: bufferToUuid(row.store_id), storeName: row.store_name,
    variantId: bufferToUuid(row.variant_id), sellerSku: row.seller_sku, status: row.status,
    fulfillmentType: row.fulfillment_type, handlingTimeHours: Number(row.handling_time_hours || 0),
    productName: row.product_name, variantName: row.variant_name, catalogSku: row.catalog_sku,
    vertical: row.vertical, listPrice: number(row.list_price), salePrice: number(row.sale_price),
    costPrice: number(row.cost_price), availableQuantity: number(row.available_quantity) || 0,
    createdAt: iso(row.created_at)
  };
}

const vendorSelect = `SELECT m.*, vp.onboarding_status, vp.business_type, vp.contact_person,
  vp.default_commission_rate, vp.settlement_cycle_days, vp.notes,
  a.line1, a.line2, a.city, a.district, a.state_code, a.state_name, a.postal_code, a.country_code,
  (SELECT gr.gstin FROM gst_registrations gr WHERE gr.merchant_id = m.id AND gr.status = 'ACTIVE'
    ORDER BY gr.created_at DESC LIMIT 1) AS gstin,
  (SELECT COUNT(*) FROM store_merchants sm WHERE sm.merchant_id = m.id AND sm.status = 'ACTIVE') AS store_count,
  (SELECT COUNT(*) FROM seller_offers so WHERE so.merchant_id = m.id AND so.deleted_at IS NULL) AS offer_count,
  (SELECT COUNT(*) FROM seller_offers so WHERE so.merchant_id = m.id AND so.status = 'ACTIVE' AND so.deleted_at IS NULL) AS active_offer_count,
  (SELECT COUNT(DISTINCT pv.product_id) FROM seller_offers so JOIN product_variants pv ON pv.id = so.variant_id
    WHERE so.merchant_id = m.id AND so.deleted_at IS NULL) AS product_count,
  (SELECT COUNT(*) FROM seller_orders seller WHERE seller.merchant_id = m.id) AS order_count,
  (SELECT COALESCE(SUM(seller.grand_total), 0) FROM seller_orders seller WHERE seller.merchant_id = m.id
    AND seller.status <> 'CANCELLED') AS gross_sales,
  (SELECT COALESCE(SUM(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity), 0)
    FROM inventory_balances ib JOIN seller_offers so ON so.id = ib.offer_id WHERE so.merchant_id = m.id) AS available_units
  FROM merchants m JOIN vendor_profiles vp ON vp.merchant_id = m.id
  LEFT JOIN addresses a ON a.id = m.primary_address_id`;

export async function listVendors({ tenantId, filters, connection = getPrimaryPool() }) {
  const where = ["m.tenant_id = ?", "m.merchant_type = 'VENDOR'", "m.deleted_at IS NULL"];
  const parameters = [uuidToBuffer(tenantId)];
  if (filters.search) {
    const search = `%${escapeSearch(filters.search)}%`;
    where.push(`(m.display_name LIKE ? ESCAPE '\\\\' OR m.legal_name LIKE ? ESCAPE '\\\\'
      OR m.merchant_code LIKE ? ESCAPE '\\\\' OR m.pan LIKE ? ESCAPE '\\\\'
      OR EXISTS (SELECT 1 FROM gst_registrations sg WHERE sg.merchant_id = m.id AND sg.gstin LIKE ? ESCAPE '\\\\'))`);
    parameters.push(search, search, search, search, search);
  }
  if (filters.status !== "ALL") { where.push("m.status = ?"); parameters.push(filters.status); }
  const clause = where.join(" AND ");
  const offset = (filters.page - 1) * filters.pageSize;
  const [rowsResult, countResult, summaryResult] = await Promise.all([
    connection.execute(`${vendorSelect} WHERE ${clause} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
      [...parameters, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total FROM merchants m WHERE ${clause}`, parameters),
    connection.execute(`SELECT COUNT(*) AS total, SUM(status = 'PENDING') AS pending,
      SUM(status = 'ACTIVE') AS active, SUM(status = 'SUSPENDED') AS suspended
      FROM merchants WHERE tenant_id = ? AND merchant_type = 'VENDOR' AND deleted_at IS NULL`, [uuidToBuffer(tenantId)])
  ]);
  const total = Number(countResult[0][0].total || 0);
  const summary = summaryResult[0][0];
  return { items: rowsResult[0].map(mapVendor), total, page: filters.page, pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)), summary: {
      total: Number(summary.total || 0), pending: Number(summary.pending || 0),
      active: Number(summary.active || 0), suspended: Number(summary.suspended || 0)
    } };
}

export async function listVendorOptions({ tenantId, variantSearch, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const variantParameters = [tenant];
  let variantClause = "";
  if (variantSearch) {
    const search = `%${escapeSearch(variantSearch)}%`;
    variantClause = ` AND (p.name LIKE ? ESCAPE '\\\\' OR pv.name LIKE ? ESCAPE '\\\\' OR pv.sku LIKE ? ESCAPE '\\\\')`;
    variantParameters.push(search, search, search);
  }
  const [storeResult, variantResult] = await Promise.all([
    connection.execute(`SELECT id, code, name, base_currency FROM stores
      WHERE tenant_id = ? AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY name`, [tenant]),
    connection.execute(`SELECT pv.id, pv.sku, pv.name AS variant_name, p.name AS product_name,
      pt.vertical FROM product_variants pv JOIN products p ON p.id = pv.product_id
      JOIN product_types pt ON pt.id = p.product_type_id
      WHERE pv.tenant_id = ? AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL
        AND p.deleted_at IS NULL ${variantClause} ORDER BY p.name, pv.name LIMIT 100`, variantParameters)
  ]);
  return {
    stores: storeResult[0].map((row) => ({ id: bufferToUuid(row.id), code: row.code,
      name: row.name, currency: row.base_currency })),
    variants: variantResult[0].map((row) => ({ id: bufferToUuid(row.id), sku: row.sku,
      variantName: row.variant_name, productName: row.product_name, vertical: row.vertical }))
  };
}

export async function getVendor({ tenantId, vendorId, connection = getPrimaryPool(), forUpdate = false }) {
  const tenant = uuidToBuffer(tenantId); const vendor = uuidToBuffer(vendorId);
  const [vendorRows] = await connection.execute(`${vendorSelect}
    WHERE m.tenant_id = ? AND m.id = ? AND m.merchant_type = 'VENDOR' AND m.deleted_at IS NULL LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
  [tenant, vendor]);
  if (!vendorRows[0]) return null;
  const [storesResult, offersResult, documentsResult] = await Promise.all([
    connection.execute(`SELECT s.id, s.code, s.name, sm.status FROM store_merchants sm
      JOIN stores s ON s.id = sm.store_id WHERE s.tenant_id = ? AND sm.merchant_id = ? ORDER BY s.name`, [tenant, vendor]),
    connection.execute(`SELECT so.id, so.store_id, s.name AS store_name, so.variant_id, so.seller_sku,
      so.status, so.fulfillment_type, so.handling_time_hours, so.created_at, p.name AS product_name,
      pv.name AS variant_name, pv.sku AS catalog_sku, pt.vertical, price.list_price,
      price.sale_price, price.cost_price,
      COALESCE((SELECT SUM(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity)
        FROM inventory_balances ib WHERE ib.offer_id = so.id), 0) AS available_quantity
      FROM seller_offers so JOIN stores s ON s.id = so.store_id
      JOIN product_variants pv ON pv.id = so.variant_id JOIN products p ON p.id = pv.product_id
      JOIN product_types pt ON pt.id = p.product_type_id
      LEFT JOIN offer_prices price ON price.id = (SELECT op.id FROM offer_prices op
        WHERE op.offer_id = so.id AND (op.starts_at IS NULL OR op.starts_at <= UTC_TIMESTAMP())
          AND (op.ends_at IS NULL OR op.ends_at > UTC_TIMESTAMP()) ORDER BY op.starts_at DESC LIMIT 1)
      WHERE so.tenant_id = ? AND so.merchant_id = ? AND so.deleted_at IS NULL
      ORDER BY so.created_at DESC LIMIT 100`, [tenant, vendor]),
    connection.execute(`SELECT vd.id, vd.document_type, vd.document_number, vd.verification_status,
      vd.original_file_name, vd.mime_type, vd.file_size, vd.rejection_reason, vd.expires_at,
      vd.verified_at, vd.created_at, vd.updated_at,
      NULLIF(TRIM(CONCAT_WS(' ', verifier.first_name, verifier.last_name)), '') AS verified_by_name
      FROM vendor_documents vd LEFT JOIN users verifier ON verifier.id = vd.verified_by
      WHERE vd.tenant_id = ? AND vd.merchant_id = ? ORDER BY vd.created_at DESC`, [tenant, vendor])
  ]);
  return { vendor: mapVendor(vendorRows[0]),
    stores: storesResult[0].map((row) => ({ id: bufferToUuid(row.id), code: row.code, name: row.name, status: row.status })),
    offers: offersResult[0].map(mapOffer),
    documents: documentsResult[0].map(mapDocument) };
}

export async function insertVendorDocument({ document, connection }) {
  await connection.execute(`INSERT INTO vendor_documents (id, tenant_id, merchant_id, document_type,
    document_number, file_key, original_file_name, mime_type, file_size, verification_status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
  [uuidToBuffer(document.id), uuidToBuffer(document.tenantId), uuidToBuffer(document.vendorId),
    document.type, document.number || null, document.fileKey, document.originalName,
    document.mimeType, document.byteSize, document.expiresAt || null]);
}

export async function getVendorDocument({ tenantId, vendorId, documentId, connection = getPrimaryPool(),
  forUpdate = false }) {
  const [rows] = await connection.execute(`SELECT vd.id, vd.document_type, vd.document_number,
    vd.file_key, vd.original_file_name, vd.mime_type, vd.file_size, vd.verification_status,
    vd.rejection_reason, vd.expires_at, vd.verified_at, vd.created_at, vd.updated_at,
    NULLIF(TRIM(CONCAT_WS(' ', verifier.first_name, verifier.last_name)), '') AS verified_by_name
    FROM vendor_documents vd LEFT JOIN users verifier ON verifier.id = vd.verified_by
    JOIN merchants m ON m.id = vd.merchant_id AND m.tenant_id = vd.tenant_id
    WHERE vd.tenant_id = ? AND vd.merchant_id = ? AND vd.id = ?
      AND m.merchant_type = 'VENDOR' AND m.deleted_at IS NULL LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
  [uuidToBuffer(tenantId), uuidToBuffer(vendorId), uuidToBuffer(documentId)]);
  return rows[0] ? { ...mapDocument(rows[0]), fileKey: rows[0].file_key } : null;
}

export async function updateVendorDocumentDecision({ tenantId, vendorId, documentId, decision,
  rejectionReason, actorUserId, connection }) {
  await connection.execute(`UPDATE vendor_documents SET verification_status = ?, verified_by = ?,
    verified_at = UTC_TIMESTAMP(6), rejection_reason = ?
    WHERE tenant_id = ? AND merchant_id = ? AND id = ?`,
  [decision, uuidToBuffer(actorUserId), decision === "REJECTED" ? rejectionReason : null,
    uuidToBuffer(tenantId), uuidToBuffer(vendorId), uuidToBuffer(documentId)]);
}

export async function findVendorDuplicates({ tenantId, code, pan, gstin, connection }) {
  const [rows] = await connection.execute(`SELECT
    EXISTS(SELECT 1 FROM merchants WHERE tenant_id = ? AND merchant_code = ? AND deleted_at IS NULL) AS duplicate_code,
    EXISTS(SELECT 1 FROM merchants WHERE tenant_id = ? AND pan = ? AND deleted_at IS NULL) AS duplicate_pan,
    EXISTS(SELECT 1 FROM gst_registrations WHERE tenant_id = ? AND gstin = ?) AS duplicate_gstin`,
  [uuidToBuffer(tenantId), code, uuidToBuffer(tenantId), pan, uuidToBuffer(tenantId), gstin]);
  return { code: Boolean(rows[0].duplicate_code), pan: Boolean(rows[0].duplicate_pan), gstin: Boolean(rows[0].duplicate_gstin) };
}

export async function findActiveStores({ tenantId, storeIds, connection }) {
  const placeholders = storeIds.map(() => "?").join(",");
  const [rows] = await connection.execute(`SELECT id FROM stores WHERE tenant_id = ? AND status = 'ACTIVE'
    AND deleted_at IS NULL AND id IN (${placeholders})`, [uuidToBuffer(tenantId), ...storeIds.map(uuidToBuffer)]);
  return rows.map((row) => bufferToUuid(row.id));
}

export async function insertAddress({ address, connection }) {
  await connection.execute(`INSERT INTO addresses (id, tenant_id, contact_name, company_name, line1, line2,
    city, district, state_code, state_name, postal_code, country_code, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN', ?)`,
  [uuidToBuffer(address.id), uuidToBuffer(address.tenantId), address.contactName, address.companyName,
    address.line1, address.line2 || null, address.city, address.district || null, address.stateCode,
    address.stateName, address.postalCode, address.phone]);
}

export async function insertVendor({ vendor, connection }) {
  await connection.execute(`INSERT INTO merchants (id, tenant_id, merchant_code, merchant_type, display_name,
    legal_name, status, pan, primary_address_id, support_email, support_phone)
    VALUES (?, ?, ?, 'VENDOR', ?, ?, 'PENDING', ?, ?, ?, ?)`,
  [uuidToBuffer(vendor.id), uuidToBuffer(vendor.tenantId), vendor.merchantCode, vendor.displayName,
    vendor.legalName, vendor.pan, uuidToBuffer(vendor.addressId), vendor.supportEmail, vendor.supportPhone]);
  await connection.execute(`INSERT INTO vendor_profiles (merchant_id, tenant_id, onboarding_status,
    business_type, contact_person, return_address_id, pickup_address_id, default_commission_rate,
    settlement_cycle_days, notes) VALUES (?, ?, 'SUBMITTED', ?, ?, ?, ?, ?, ?, ?)`,
  [uuidToBuffer(vendor.id), uuidToBuffer(vendor.tenantId), vendor.businessType, vendor.contactPerson,
    uuidToBuffer(vendor.addressId), uuidToBuffer(vendor.addressId), vendor.defaultCommissionRate,
    vendor.settlementCycleDays, vendor.notes || null]);
  await connection.execute(`INSERT INTO gst_registrations (id, tenant_id, merchant_id, gstin, legal_name,
    trade_name, registration_type, state_code, address_id, status)
    VALUES (?, ?, ?, ?, ?, ?, 'REGULAR', ?, ?, 'ACTIVE')`,
  [uuidToBuffer(vendor.gstId), uuidToBuffer(vendor.tenantId), uuidToBuffer(vendor.id), vendor.gstin,
    vendor.legalName, vendor.displayName, vendor.stateCode, uuidToBuffer(vendor.addressId)]);
  for (const storeId of vendor.storeIds) {
    await connection.execute(`INSERT INTO store_merchants (store_id, merchant_id, status)
      VALUES (?, ?, 'ACTIVE')`, [uuidToBuffer(storeId), uuidToBuffer(vendor.id)]);
  }
}

export async function updateVendor({ tenantId, vendorId, changes, connection }) {
  await connection.execute(`UPDATE merchants SET display_name = COALESCE(?, display_name),
    legal_name = COALESCE(?, legal_name), support_email = COALESCE(?, support_email),
    support_phone = COALESCE(?, support_phone) WHERE tenant_id = ? AND id = ? AND merchant_type = 'VENDOR'`,
  [changes.displayName ?? null, changes.legalName ?? null, changes.supportEmail ?? null,
    changes.supportPhone ?? null, uuidToBuffer(tenantId), uuidToBuffer(vendorId)]);
  await connection.execute(`UPDATE vendor_profiles SET business_type = COALESCE(?, business_type),
    contact_person = COALESCE(?, contact_person), default_commission_rate = COALESCE(?, default_commission_rate),
    settlement_cycle_days = COALESCE(?, settlement_cycle_days), notes = COALESCE(?, notes)
    WHERE tenant_id = ? AND merchant_id = ?`,
  [changes.businessType ?? null, changes.contactPerson ?? null, changes.defaultCommissionRate ?? null,
    changes.settlementCycleDays ?? null, changes.notes ?? null, uuidToBuffer(tenantId), uuidToBuffer(vendorId)]);
  if (changes.storeIds) {
    await connection.execute(`UPDATE store_merchants SET status = 'INACTIVE' WHERE merchant_id = ?`, [uuidToBuffer(vendorId)]);
    for (const storeId of changes.storeIds) {
      await connection.execute(`INSERT INTO store_merchants (store_id, merchant_id, status) VALUES (?, ?, 'ACTIVE')
        ON DUPLICATE KEY UPDATE status = 'ACTIVE'`, [uuidToBuffer(storeId), uuidToBuffer(vendorId)]);
    }
  }
}

function mapDocument(row) {
  return {
    id: bufferToUuid(row.id), type: row.document_type, number: row.document_number || "",
    status: row.verification_status, fileName: row.original_file_name || null,
    mimeType: row.mime_type || null, byteSize: number(row.file_size),
    rejectionReason: row.rejection_reason || "", expiresAt: iso(row.expires_at),
    verifiedAt: iso(row.verified_at), verifiedByName: row.verified_by_name || null,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

export async function updateVendorLogo({ tenantId, vendorId, logoUrl, connection }) {
  await connection.execute(`UPDATE merchants SET logo_url = ?
    WHERE tenant_id = ? AND id = ? AND merchant_type = 'VENDOR' AND deleted_at IS NULL`,
  [logoUrl, uuidToBuffer(tenantId), uuidToBuffer(vendorId)]);
}

export async function updateVendorStatus({ tenantId, vendorId, status, onboardingStatus, actorUserId, connection }) {
  await connection.execute(`UPDATE merchants SET status = ?, approved_at = CASE WHEN ? = 'ACTIVE' THEN COALESCE(approved_at, UTC_TIMESTAMP(6)) ELSE approved_at END,
    approved_by = CASE WHEN ? = 'ACTIVE' THEN COALESCE(approved_by, ?) ELSE approved_by END
    WHERE tenant_id = ? AND id = ? AND merchant_type = 'VENDOR'`,
  [status, status, status, uuidToBuffer(actorUserId), uuidToBuffer(tenantId), uuidToBuffer(vendorId)]);
  await connection.execute(`UPDATE vendor_profiles SET onboarding_status = ? WHERE tenant_id = ? AND merchant_id = ?`,
    [onboardingStatus, uuidToBuffer(tenantId), uuidToBuffer(vendorId)]);
}

export async function findOfferContext({ tenantId, vendorId, storeId, variantId, connection }) {
  const [rows] = await connection.execute(`SELECT m.id AS merchant_id, m.status AS merchant_status,
    s.id AS store_id, pv.id AS variant_id, p.tax_category_id, pl.id AS price_list_id
    FROM merchants m JOIN store_merchants sm ON sm.merchant_id = m.id AND sm.status = 'ACTIVE'
    JOIN stores s ON s.id = sm.store_id AND s.status = 'ACTIVE' AND s.deleted_at IS NULL
    JOIN product_variants pv ON pv.tenant_id = m.tenant_id AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL
    JOIN products p ON p.id = pv.product_id AND p.deleted_at IS NULL
    JOIN price_lists pl ON pl.tenant_id = m.tenant_id AND pl.code = 'DEFAULT_INR' AND pl.status = 'ACTIVE'
    WHERE m.tenant_id = ? AND m.id = ? AND m.merchant_type = 'VENDOR' AND m.deleted_at IS NULL
      AND s.id = ? AND pv.id = ? LIMIT 1 FOR UPDATE`,
  [uuidToBuffer(tenantId), uuidToBuffer(vendorId), uuidToBuffer(storeId), uuidToBuffer(variantId)]);
  return rows[0] ? { merchantId: bufferToUuid(rows[0].merchant_id), merchantStatus: rows[0].merchant_status,
    storeId: bufferToUuid(rows[0].store_id), variantId: bufferToUuid(rows[0].variant_id),
    taxCategoryId: bufferToUuid(rows[0].tax_category_id), priceListId: bufferToUuid(rows[0].price_list_id) } : null;
}

export async function findDuplicateOffer({ storeId, vendorId, variantId, sellerSku, connection }) {
  const [rows] = await connection.execute(`SELECT id FROM seller_offers WHERE store_id = ? AND merchant_id = ?
    AND deleted_at IS NULL AND (variant_id = ? OR seller_sku = ?) LIMIT 1`,
  [uuidToBuffer(storeId), uuidToBuffer(vendorId), uuidToBuffer(variantId), sellerSku]);
  return rows[0] ? bufferToUuid(rows[0].id) : null;
}

export async function insertVendorOffer({ offer, price, connection }) {
  await connection.execute(`INSERT INTO seller_offers (id, tenant_id, store_id, merchant_id, variant_id,
    seller_sku, status, fulfillment_type, handling_time_hours, tax_category_id, approved_by, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
  [uuidToBuffer(offer.id), uuidToBuffer(offer.tenantId), uuidToBuffer(offer.storeId),
    uuidToBuffer(offer.vendorId), uuidToBuffer(offer.variantId), offer.sellerSku, offer.fulfillmentType,
    offer.handlingTimeHours, offer.taxCategoryId ? uuidToBuffer(offer.taxCategoryId) : null,
    uuidToBuffer(offer.actorUserId)]);
  await insertOfferPrice({ price, connection });
}

export async function findVendorOffer({ tenantId, vendorId, offerId, connection, forUpdate = false }) {
  const [rows] = await connection.execute(`SELECT so.id, so.status, so.handling_time_hours,
    op.price_list_id, op.list_price, op.sale_price, op.cost_price
    FROM seller_offers so LEFT JOIN offer_prices op ON op.id = (SELECT current_price.id FROM offer_prices current_price
      WHERE current_price.offer_id = so.id AND current_price.ends_at IS NULL ORDER BY current_price.starts_at DESC LIMIT 1)
    WHERE so.tenant_id = ? AND so.merchant_id = ? AND so.id = ? AND so.deleted_at IS NULL LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
  [uuidToBuffer(tenantId), uuidToBuffer(vendorId), uuidToBuffer(offerId)]);
  return rows[0] ? { id: bufferToUuid(rows[0].id), status: rows[0].status,
    handlingTimeHours: Number(rows[0].handling_time_hours || 0), priceListId: bufferToUuid(rows[0].price_list_id),
    listPrice: number(rows[0].list_price), salePrice: number(rows[0].sale_price), costPrice: number(rows[0].cost_price) } : null;
}

export async function updateVendorOffer({ offerId, status, handlingTimeHours, connection }) {
  await connection.execute(`UPDATE seller_offers SET status = COALESCE(?, status),
    handling_time_hours = COALESCE(?, handling_time_hours) WHERE id = ?`,
  [status ?? null, handlingTimeHours ?? null, uuidToBuffer(offerId)]);
}

export async function closeOfferPrice({ offerId, priceListId, connection }) {
  await connection.execute(`UPDATE offer_prices SET ends_at = UTC_TIMESTAMP(6)
    WHERE offer_id = ? AND price_list_id = ? AND ends_at IS NULL`,
  [uuidToBuffer(offerId), uuidToBuffer(priceListId)]);
}

export async function insertOfferPrice({ price, connection }) {
  await connection.execute(`INSERT INTO offer_prices (id, tenant_id, offer_id, price_list_id,
    list_price, sale_price, cost_price, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), NULL)`,
  [uuidToBuffer(price.id), uuidToBuffer(price.tenantId), uuidToBuffer(price.offerId),
    uuidToBuffer(price.priceListId), price.listPrice, price.salePrice, price.costPrice]);
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action,
    entity_type, entity_id, request_id, ip_address, user_agent, before_data, after_data)
    VALUES (?, ?, ?, 'USER', ?, ?, ?, ?, INET6_ATON(?), ?, ?, ?)`,
  [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId), audit.action,
    audit.entityType, uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress, audit.userAgent,
    JSON.stringify(audit.beforeData), JSON.stringify(audit.afterData)]);
}

export async function findUserByEmail({ email, connection }) {
  const [rows] = await connection.execute(
    "SELECT id FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1", [email]);
  return rows[0] ? { id: bufferToUuid(rows[0].id) } : null;
}

export async function findVendorRole({ tenantId, roleKey, connection }) {
  const [rows] = await connection.execute(`SELECT id FROM roles WHERE tenant_id = ? AND role_key = ?
    AND role_level = 'VENDOR' AND deleted_at IS NULL LIMIT 1`, [uuidToBuffer(tenantId), roleKey]);
  return rows[0] ? { id: bufferToUuid(rows[0].id) } : null;
}

export async function insertVendorUser({ user, connection }) {
  await connection.execute(`INSERT INTO users (id, email, password_hash, first_name, last_name,
    status, password_changed_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(6))`,
  [uuidToBuffer(user.id), user.email, user.passwordHash, user.firstName, user.lastName || null]);
}

export async function insertVendorMembership({ membership, connection }) {
  await connection.execute(`INSERT INTO tenant_memberships (id, tenant_id, user_id, membership_type,
    status, invited_by, invited_at, joined_at) VALUES (?, ?, ?, 'STAFF', 'ACTIVE', ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
  [uuidToBuffer(membership.id), uuidToBuffer(membership.tenantId), uuidToBuffer(membership.userId),
    uuidToBuffer(membership.invitedBy)]);
}

export async function insertVendorAssignment({ assignment, connection }) {
  await connection.execute(`INSERT INTO user_role_assignments (id, user_id, tenant_id, role_id,
    scope_type, scope_id, assigned_by) VALUES (?, ?, ?, ?, 'MERCHANT', ?, ?)`,
  [uuidToBuffer(assignment.id), uuidToBuffer(assignment.userId), uuidToBuffer(assignment.tenantId),
    uuidToBuffer(assignment.roleId), uuidToBuffer(assignment.vendorId), uuidToBuffer(assignment.assignedBy)]);
}
