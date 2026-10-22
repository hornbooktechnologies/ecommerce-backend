import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

function number(value) { return value === null || value === undefined ? null : Number(value); }
function escapeLike(value) { return value.replace(/[\\%_]/g, (character) => `\\${character}`); }
const activePrice = (variantAlias) => `(SELECT MIN(op.sale_price) FROM seller_offers so
  JOIN offer_prices op ON op.offer_id = so.id WHERE so.variant_id = ${variantAlias}.id
  AND so.deleted_at IS NULL AND so.status = 'ACTIVE' AND op.ends_at IS NULL
  AND (op.starts_at IS NULL OR op.starts_at <= UTC_TIMESTAMP(6)))`;
const available = (variantAlias) => `(SELECT COALESCE(SUM(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity), 0)
  FROM seller_offers so JOIN inventory_balances ib ON ib.offer_id = so.id
  WHERE so.variant_id = ${variantAlias}.id AND so.deleted_at IS NULL AND so.status = 'ACTIVE')`;

function mapVariant(row) {
  return { id: bufferToUuid(row.id), productId: bufferToUuid(row.product_id), productCode: row.product_code,
    productName: row.product_name, productKind: row.product_kind, vertical: row.vertical,
    sku: row.sku, variantName: row.variant_name || "Standard", status: row.status,
    salePrice: number(row.sale_price), availableQuantity: number(row.available_quantity) || 0,
    primaryImageUrl: row.primary_image_url || null };
}

function mapComponent(row) {
  return { id: bufferToUuid(row.component_id), bundleVariantId: bufferToUuid(row.bundle_variant_id),
    componentVariantId: bufferToUuid(row.component_variant_id), quantity: number(row.quantity),
    isOptional: Boolean(row.is_optional), sortOrder: Number(row.sort_order),
    productId: bufferToUuid(row.product_id), productCode: row.product_code, productName: row.product_name,
    productKind: row.product_kind, vertical: row.vertical, sku: row.sku,
    variantName: row.variant_name || "Standard", status: row.status,
    salePrice: number(row.sale_price), availableQuantity: number(row.available_quantity) || 0,
    primaryImageUrl: row.primary_image_url || null };
}

const baseVariantSelect = (alias = "pv") => `${alias}.id, ${alias}.product_id, ${alias}.sku,
  ${alias}.name AS variant_name, ${alias}.status, p.product_code, p.name AS product_name,
  p.product_kind, pt.vertical, ${activePrice(alias)} AS sale_price, ${available(alias)} AS available_quantity,
  (SELECT ma.file_key FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
    WHERE pm.product_id = p.id AND ma.deleted_at IS NULL
    ORDER BY (pm.variant_id = ${alias}.id) DESC, (pm.media_role = 'PRIMARY') DESC, pm.sort_order LIMIT 1) AS primary_image_url`;

export async function listVariantOptions({ tenantId, search, kind, page, pageSize, connection = getPrimaryPool() }) {
  const where = ["pv.tenant_id = ?", "pv.deleted_at IS NULL", "p.deleted_at IS NULL", "pv.status = 'ACTIVE'"];
  const parameters = [uuidToBuffer(tenantId)];
  if (kind === "BUNDLE") where.push("p.product_kind = 'BUNDLE'");
  if (kind === "STANDARD") where.push("p.product_kind = 'STANDARD'");
  if (search) { const term = `%${escapeLike(search)}%`; where.push("(p.name LIKE ? ESCAPE '\\\\' OR p.product_code LIKE ? ESCAPE '\\\\' OR pv.sku LIKE ? ESCAPE '\\\\')"); parameters.push(term, term, term); }
  const clause = where.join(" AND "); const offset = (page - 1) * pageSize;
  const [[countRows], [rows]] = await Promise.all([
    connection.execute(`SELECT COUNT(*) AS total FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE ${clause}`, parameters),
    connection.execute(`SELECT ${baseVariantSelect()} FROM product_variants pv JOIN products p ON p.id = pv.product_id
      JOIN product_types pt ON pt.id = p.product_type_id WHERE ${clause} ORDER BY p.name, pv.sku LIMIT ? OFFSET ?`, [...parameters, pageSize, offset])
  ]);
  return { items: rows.map(mapVariant), total: Number(countRows[0].total) };
}

export async function listBundles({ tenantId, search, page, pageSize, connection = getPrimaryPool() }) {
  const where = ["pv.tenant_id = ?", "pv.deleted_at IS NULL", "p.deleted_at IS NULL", "p.product_kind = 'BUNDLE'"];
  const parameters = [uuidToBuffer(tenantId)];
  if (search) { const term = `%${escapeLike(search)}%`; where.push("(p.name LIKE ? ESCAPE '\\\\' OR p.product_code LIKE ? ESCAPE '\\\\' OR pv.sku LIKE ? ESCAPE '\\\\')"); parameters.push(term, term, term); }
  const clause = where.join(" AND "); const offset = (page - 1) * pageSize;
  const [[countRows], [bundleRows], [summaryRows]] = await Promise.all([
    connection.execute(`SELECT COUNT(*) AS total FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE ${clause}`, parameters),
    connection.execute(`SELECT ${baseVariantSelect()} FROM product_variants pv JOIN products p ON p.id = pv.product_id
      JOIN product_types pt ON pt.id = p.product_type_id WHERE ${clause} ORDER BY p.updated_at DESC, p.name LIMIT ? OFFSET ?`, [...parameters, pageSize, offset]),
    connection.execute(`SELECT COUNT(DISTINCT pv.id) AS total_bundles, COUNT(pbc.id) AS component_lines,
        SUM(CASE WHEN pbc.id IS NULL THEN 1 ELSE 0 END) AS incomplete_bundles
      FROM product_variants pv JOIN products p ON p.id = pv.product_id
      LEFT JOIN product_bundle_components pbc ON pbc.bundle_variant_id = pv.id
      WHERE pv.tenant_id = ? AND pv.deleted_at IS NULL AND p.deleted_at IS NULL AND p.product_kind = 'BUNDLE'`, [uuidToBuffer(tenantId)])
  ]);
  const ids = bundleRows.map((row) => row.id); let components = [];
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(", ");
    const [rows] = await connection.execute(`SELECT pbc.id AS component_id, pbc.bundle_variant_id, pbc.component_variant_id,
        pbc.quantity, pbc.is_optional, pbc.sort_order, ${baseVariantSelect("cv")}
      FROM product_bundle_components pbc JOIN product_variants cv ON cv.id = pbc.component_variant_id
      JOIN products p ON p.id = cv.product_id JOIN product_types pt ON pt.id = p.product_type_id
      WHERE pbc.tenant_id = ? AND pbc.bundle_variant_id IN (${placeholders})
      ORDER BY pbc.bundle_variant_id, pbc.sort_order, p.name, cv.sku`, [uuidToBuffer(tenantId), ...ids]);
    components = rows.map(mapComponent);
  }
  const byBundle = new Map(); for (const item of components) { const list = byBundle.get(item.bundleVariantId) || []; list.push(item); byBundle.set(item.bundleVariantId, list); }
  const summary = summaryRows[0];
  return { items: bundleRows.map((row) => ({ ...mapVariant(row), components: byBundle.get(bufferToUuid(row.id)) || [] })),
    total: Number(countRows[0].total), summary: { totalBundles: Number(summary.total_bundles) || 0,
      componentLines: Number(summary.component_lines) || 0, incompleteBundles: Number(summary.incomplete_bundles) || 0 } };
}

export async function findVariant({ tenantId, variantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT ${baseVariantSelect()} FROM product_variants pv
    JOIN products p ON p.id = pv.product_id JOIN product_types pt ON pt.id = p.product_type_id
    WHERE pv.tenant_id = ? AND pv.id = ? AND pv.deleted_at IS NULL AND p.deleted_at IS NULL LIMIT 1`,
  [uuidToBuffer(tenantId), uuidToBuffer(variantId)]);
  return rows[0] ? mapVariant(rows[0]) : null;
}

export async function findComponent({ tenantId, bundleVariantId, componentId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute("SELECT id, component_variant_id, quantity, is_optional, sort_order FROM product_bundle_components WHERE tenant_id = ? AND bundle_variant_id = ? AND id = ? LIMIT 1",
    [uuidToBuffer(tenantId), uuidToBuffer(bundleVariantId), uuidToBuffer(componentId)]);
  return rows[0] ? { id: bufferToUuid(rows[0].id), componentVariantId: bufferToUuid(rows[0].component_variant_id),
    quantity: number(rows[0].quantity), isOptional: Boolean(rows[0].is_optional), sortOrder: Number(rows[0].sort_order) } : null;
}

export async function wouldCreateCycle({ tenantId, bundleVariantId, componentVariantId, connection }) {
  const [rows] = await connection.execute(`WITH RECURSIVE descendants (variant_id) AS (
      SELECT component_variant_id FROM product_bundle_components WHERE tenant_id = ? AND bundle_variant_id = ?
      UNION DISTINCT
      SELECT pbc.component_variant_id FROM product_bundle_components pbc
      JOIN descendants d ON pbc.bundle_variant_id = d.variant_id WHERE pbc.tenant_id = ?
    ) SELECT 1 AS found FROM descendants WHERE variant_id = ? LIMIT 1`,
  [uuidToBuffer(tenantId), uuidToBuffer(componentVariantId), uuidToBuffer(tenantId), uuidToBuffer(bundleVariantId)]);
  return Boolean(rows[0]);
}

export async function nextSortOrder({ tenantId, bundleVariantId, connection }) {
  const [rows] = await connection.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM product_bundle_components WHERE tenant_id = ? AND bundle_variant_id = ?",
    [uuidToBuffer(tenantId), uuidToBuffer(bundleVariantId)]); return Number(rows[0].next_order);
}

export async function insertComponent({ component, connection }) {
  await connection.execute(`INSERT INTO product_bundle_components
    (id, tenant_id, bundle_variant_id, component_variant_id, quantity, is_optional, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [uuidToBuffer(component.id), uuidToBuffer(component.tenantId),
    uuidToBuffer(component.bundleVariantId), uuidToBuffer(component.componentVariantId), component.quantity,
    component.isOptional ? 1 : 0, component.sortOrder]);
}
export async function updateComponent({ componentId, input, connection }) {
  await connection.execute("UPDATE product_bundle_components SET quantity = ?, is_optional = ?, sort_order = ? WHERE id = ?",
    [input.quantity, input.isOptional ? 1 : 0, input.sortOrder, uuidToBuffer(componentId)]);
}
export async function deleteComponent({ componentId, connection }) {
  await connection.execute("DELETE FROM product_bundle_components WHERE id = ?", [uuidToBuffer(componentId)]);
}
export async function insertAudit({ audit, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type,
      entity_id, request_id, ip_address, user_agent, after_data)
    VALUES (?, ?, ?, 'USER', ?, 'PRODUCT_BUNDLE', ?, ?, INET6_ATON(?), ?, ?)`,
  [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId), audit.action,
    uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress, audit.userAgent, JSON.stringify(audit.afterData)]);
}
