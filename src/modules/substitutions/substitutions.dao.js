import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

function number(value) { return value === null || value === undefined ? null : Number(value); }
function escapeLike(value) { return value.replace(/[\\%_]/g, (character) => `\\${character}`); }

function mapVariant(row) {
  return {
    id: bufferToUuid(row.id), productId: bufferToUuid(row.product_id), productCode: row.product_code,
    productName: row.product_name, sku: row.sku, variantName: row.variant_name || "Standard",
    status: row.status, allowSubstitutions: Boolean(row.allow_substitutions), salePrice: number(row.sale_price),
    primaryImageUrl: row.primary_image_url || null
  };
}

function mapRule(row) {
  return {
    id: bufferToUuid(row.id), priority: Number(row.priority),
    maximumPriceDifferencePercent: number(row.maximum_price_difference_percent), status: row.status,
    source: { id: bufferToUuid(row.source_variant_id), productId: bufferToUuid(row.source_product_id),
      productCode: row.source_product_code, productName: row.source_product_name, sku: row.source_sku,
      variantName: row.source_variant_name || "Standard", salePrice: number(row.source_price) },
    substitute: { id: bufferToUuid(row.substitute_variant_id), productId: bufferToUuid(row.substitute_product_id),
      productCode: row.substitute_product_code, productName: row.substitute_product_name, sku: row.substitute_sku,
      variantName: row.substitute_variant_name || "Standard", salePrice: number(row.substitute_price) }
  };
}

const priceSql = (alias) => `(SELECT MIN(op.sale_price) FROM seller_offers so
  JOIN offer_prices op ON op.offer_id = so.id
  WHERE so.variant_id = ${alias}.id AND so.deleted_at IS NULL AND so.status = 'ACTIVE'
    AND op.ends_at IS NULL AND (op.starts_at IS NULL OR op.starts_at <= UTC_TIMESTAMP(6)))`;

export async function listVariants({ tenantId, search, sourceOnly = false, page, pageSize,
  connection = getPrimaryPool() }) {
  const where = ["pv.tenant_id = ?", "pv.deleted_at IS NULL", "p.deleted_at IS NULL",
    "pv.status = 'ACTIVE'", "pt.vertical = 'GROCERY'"];
  const parameters = [uuidToBuffer(tenantId)];
  if (sourceOnly) where.push("JSON_UNQUOTE(JSON_EXTRACT(p.metadata, '$.grocery.allowSubstitutions')) IN ('true', '1')");
  if (search) {
    const term = `%${escapeLike(search)}%`;
    where.push("(p.name LIKE ? ESCAPE '\\\\' OR p.product_code LIKE ? ESCAPE '\\\\' OR pv.sku LIKE ? ESCAPE '\\\\')");
    parameters.push(term, term, term);
  }
  const clause = where.join(" AND "); const offset = (page - 1) * pageSize;
  const [[count], [rows]] = await Promise.all([
    connection.execute(`SELECT COUNT(*) AS total FROM product_variants pv
      JOIN products p ON p.id = pv.product_id JOIN product_types pt ON pt.id = p.product_type_id WHERE ${clause}`, parameters),
    connection.execute(`SELECT pv.id, pv.product_id, pv.sku, pv.name AS variant_name, pv.status,
        p.product_code, p.name AS product_name,
        JSON_UNQUOTE(JSON_EXTRACT(p.metadata, '$.grocery.allowSubstitutions')) IN ('true', '1') AS allow_substitutions,
        ${priceSql("pv")} AS sale_price,
        (SELECT ma.file_key FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
          WHERE pm.product_id = p.id AND ma.deleted_at IS NULL
          ORDER BY (pm.variant_id = pv.id) DESC, (pm.media_role = 'PRIMARY') DESC, pm.sort_order LIMIT 1) AS primary_image_url
      FROM product_variants pv JOIN products p ON p.id = pv.product_id
      JOIN product_types pt ON pt.id = p.product_type_id WHERE ${clause}
      ORDER BY p.name, pv.sku LIMIT ? OFFSET ?`, [...parameters, pageSize, offset])
  ]);
  return { items: rows.map(mapVariant), total: Number(count[0].total) };
}

export async function findVariant({ tenantId, variantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT pv.id, pv.product_id, pv.sku, pv.name AS variant_name, pv.status,
      p.product_code, p.name AS product_name, pt.vertical,
      JSON_UNQUOTE(JSON_EXTRACT(p.metadata, '$.grocery.allowSubstitutions')) IN ('true', '1') AS allow_substitutions,
      ${priceSql("pv")} AS sale_price, NULL AS primary_image_url
    FROM product_variants pv JOIN products p ON p.id = pv.product_id JOIN product_types pt ON pt.id = p.product_type_id
    WHERE pv.tenant_id = ? AND pv.id = ? AND pv.deleted_at IS NULL AND p.deleted_at IS NULL LIMIT 1`,
  [uuidToBuffer(tenantId), uuidToBuffer(variantId)]);
  return rows[0] ? { ...mapVariant(rows[0]), vertical: rows[0].vertical } : null;
}

export async function listRules({ tenantId, search, status, page, pageSize, connection = getPrimaryPool() }) {
  const where = ["ps.tenant_id = ?"]; const parameters = [uuidToBuffer(tenantId)];
  if (status !== "ALL") { where.push("ps.status = ?"); parameters.push(status); }
  if (search) {
    const term = `%${escapeLike(search)}%`;
    where.push("(sp.name LIKE ? ESCAPE '\\\\' OR sv.sku LIKE ? ESCAPE '\\\\' OR tp.name LIKE ? ESCAPE '\\\\' OR tv.sku LIKE ? ESCAPE '\\\\')");
    parameters.push(term, term, term, term);
  }
  const clause = where.join(" AND "); const offset = (page - 1) * pageSize;
  const joins = `FROM product_substitutes ps
    JOIN product_variants sv ON sv.id = ps.source_variant_id JOIN products sp ON sp.id = sv.product_id
    JOIN product_variants tv ON tv.id = ps.substitute_variant_id JOIN products tp ON tp.id = tv.product_id`;
  const [[count], [rows], [summaryRows]] = await Promise.all([
    connection.execute(`SELECT COUNT(*) AS total ${joins} WHERE ${clause}`, parameters),
    connection.execute(`SELECT ps.id, ps.priority, ps.maximum_price_difference_percent, ps.status,
        sv.id AS source_variant_id, sp.id AS source_product_id, sp.product_code AS source_product_code,
        sp.name AS source_product_name, sv.sku AS source_sku, sv.name AS source_variant_name, ${priceSql("sv")} AS source_price,
        tv.id AS substitute_variant_id, tp.id AS substitute_product_id, tp.product_code AS substitute_product_code,
        tp.name AS substitute_product_name, tv.sku AS substitute_sku, tv.name AS substitute_variant_name, ${priceSql("tv")} AS substitute_price
      ${joins} WHERE ${clause} ORDER BY sp.name, sv.sku, ps.priority, tp.name LIMIT ? OFFSET ?`,
    [...parameters, pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total, SUM(status = 'ACTIVE') AS active,
        COUNT(DISTINCT CASE WHEN status = 'ACTIVE' THEN source_variant_id END) AS covered_sources
      FROM product_substitutes WHERE tenant_id = ?`, [uuidToBuffer(tenantId)])
  ]);
  const summary = summaryRows[0];
  return { items: rows.map(mapRule), total: Number(count[0].total), summary: {
    total: Number(summary.total), active: Number(summary.active) || 0, coveredSources: Number(summary.covered_sources) || 0
  } };
}

export async function findRule({ tenantId, ruleId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute("SELECT id, source_variant_id, substitute_variant_id, priority, maximum_price_difference_percent, status FROM product_substitutes WHERE tenant_id = ? AND id = ? LIMIT 1",
    [uuidToBuffer(tenantId), uuidToBuffer(ruleId)]);
  if (!rows[0]) return null;
  return { id: bufferToUuid(rows[0].id), sourceVariantId: bufferToUuid(rows[0].source_variant_id),
    substituteVariantId: bufferToUuid(rows[0].substitute_variant_id), priority: Number(rows[0].priority),
    maximumPriceDifferencePercent: number(rows[0].maximum_price_difference_percent), status: rows[0].status };
}

export async function insertRule({ rule, connection }) {
  await connection.execute(`INSERT INTO product_substitutes
    (id, tenant_id, source_variant_id, substitute_variant_id, priority, maximum_price_difference_percent, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [uuidToBuffer(rule.id), uuidToBuffer(rule.tenantId),
    uuidToBuffer(rule.sourceVariantId), uuidToBuffer(rule.substituteVariantId), rule.priority,
    rule.maximumPriceDifferencePercent, rule.status]);
}

export async function updateRule({ ruleId, input, connection }) {
  await connection.execute(`UPDATE product_substitutes SET priority = ?, maximum_price_difference_percent = ?, status = ?
    WHERE id = ?`, [input.priority, input.maximumPriceDifferencePercent, input.status, uuidToBuffer(ruleId)]);
}

export async function deleteRule({ ruleId, connection }) {
  await connection.execute("DELETE FROM product_substitutes WHERE id = ?", [uuidToBuffer(ruleId)]);
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type,
      entity_id, request_id, ip_address, user_agent, after_data)
    VALUES (?, ?, ?, 'USER', ?, 'PRODUCT_SUBSTITUTE', ?, ?, INET6_ATON(?), ?, ?)`,
  [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId), audit.action,
    uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress, audit.userAgent, JSON.stringify(audit.afterData)]);
}
