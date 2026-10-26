import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

const number = (value) => Number(value || 0);
const iso = (value) => value instanceof Date ? value.toISOString() : value;
const escapeSearch = (value) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

function mapRating(row) {
  return {
    id: bufferToUuid(row.id), productId: bufferToUuid(row.product_id), productName: row.product_name,
    productCode: row.product_code, sku: row.sku || "No active SKU", imageUrl: row.image_url || null,
    customerId: bufferToUuid(row.customer_id), customerName: row.customer_name || "Anonymous customer",
    customerEmail: row.customer_email || null, orderId: bufferToUuid(row.customer_order_id),
    orderNumber: row.order_number || null, rating: number(row.rating), title: row.title || "",
    review: row.review_text || "", status: row.status, source: row.source,
    verifiedPurchase: Boolean(row.verified_purchase), helpfulCount: number(row.helpful_count),
    moderationNotes: row.moderation_notes || "", moderatedByName: row.moderated_by_name || null,
    moderatedAt: iso(row.moderated_at), submittedAt: iso(row.submitted_at), updatedAt: iso(row.updated_at)
  };
}

const ratingSelect = `SELECT pr.*, p.name AS product_name, p.product_code,
  COALESCE((SELECT MIN(pv.sku) FROM product_variants pv
    WHERE pv.product_id = p.id AND pv.deleted_at IS NULL AND pv.status = 'ACTIVE'), '') AS sku,
  (SELECT ma.file_key FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
    WHERE pm.product_id = p.id AND ma.deleted_at IS NULL
    ORDER BY (pm.media_role = 'PRIMARY') DESC, pm.sort_order, pm.created_at LIMIT 1) AS image_url,
  COALESCE(NULLIF(pr.customer_name_snapshot, ''),
    NULLIF(TRIM(CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), ''), 'Anonymous customer') AS customer_name,
  COALESCE(NULLIF(pr.customer_email_snapshot, ''), c.email) AS customer_email,
  co.order_number, CONCAT(COALESCE(u.first_name, ''),
    IF(u.last_name IS NULL OR u.last_name = '', '', CONCAT(' ', u.last_name))) AS moderated_by_name
  FROM product_ratings pr JOIN products p ON p.id = pr.product_id
  LEFT JOIN customers c ON c.id = pr.customer_id
  LEFT JOIN customer_orders co ON co.id = pr.customer_order_id
  LEFT JOIN users u ON u.id = pr.moderated_by`;

export async function listRatings({ tenantId, filters, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId); const where = ["pr.tenant_id = ?", "pr.deleted_at IS NULL", "p.deleted_at IS NULL"];
  const params = [tenant];
  if (filters.search) {
    const term = `%${escapeSearch(filters.search)}%`;
    where.push(`(p.name LIKE ? ESCAPE '\\\\' OR p.product_code LIKE ? ESCAPE '\\\\'
      OR pr.title LIKE ? ESCAPE '\\\\' OR pr.review_text LIKE ? ESCAPE '\\\\'
      OR pr.customer_name_snapshot LIKE ? ESCAPE '\\\\')`);
    params.push(term, term, term, term, term);
  }
  if (filters.status !== "ALL") { where.push("pr.status = ?"); params.push(filters.status); }
  if (filters.rating !== 0) { where.push("pr.rating = ?"); params.push(filters.rating); }
  if (filters.productId) { where.push("pr.product_id = ?"); params.push(uuidToBuffer(filters.productId)); }
  const clause = where.join(" AND "); const offset = (filters.page - 1) * filters.pageSize;
  const [rowsResult, countResult, summaryResult, distributionResult] = await Promise.all([
    connection.execute(`${ratingSelect} WHERE ${clause}
      ORDER BY FIELD(pr.status, 'FLAGGED', 'PENDING', 'PUBLISHED', 'HIDDEN'), pr.submitted_at DESC
      LIMIT ? OFFSET ?`, [...params, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total FROM product_ratings pr JOIN products p ON p.id = pr.product_id WHERE ${clause}`, params),
    connection.execute(`SELECT COUNT(*) AS total,
      SUM(status = 'PENDING') AS pending, SUM(status = 'PUBLISHED') AS published,
      SUM(status = 'FLAGGED') AS flagged, SUM(status = 'HIDDEN') AS hidden,
      COALESCE(AVG(CASE WHEN status = 'PUBLISHED' THEN rating END), 0) AS average_rating,
      SUM(status = 'PUBLISHED' AND verified_purchase = 1) AS verified_published
      FROM product_ratings WHERE tenant_id = ? AND deleted_at IS NULL`, [tenant]),
    connection.execute(`SELECT rating, COUNT(*) AS count FROM product_ratings
      WHERE tenant_id = ? AND status = 'PUBLISHED' AND deleted_at IS NULL GROUP BY rating ORDER BY rating DESC`, [tenant])
  ]);
  const total = number(countResult[0][0].total); const summary = summaryResult[0][0];
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of distributionResult[0]) distribution[number(row.rating)] = number(row.count);
  return { items: rowsResult[0].map(mapRating), total, page: filters.page, pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)), summary: {
      total: number(summary.total), pending: number(summary.pending), published: number(summary.published),
      flagged: number(summary.flagged), hidden: number(summary.hidden),
      averageRating: Number(number(summary.average_rating).toFixed(2)), verifiedPublished: number(summary.verified_published),
      distribution
    } };
}

export async function listOptions({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT p.id, p.product_code, p.name, COUNT(pr.id) AS rating_count
    FROM products p LEFT JOIN product_ratings pr ON pr.product_id = p.id AND pr.deleted_at IS NULL
    WHERE p.tenant_id = ? AND p.deleted_at IS NULL GROUP BY p.id, p.product_code, p.name
    ORDER BY rating_count DESC, p.name LIMIT 500`, [uuidToBuffer(tenantId)]);
  return { products: rows.map((row) => ({ id: bufferToUuid(row.id), code: row.product_code,
    name: row.name, ratingCount: number(row.rating_count) })) };
}

export async function getRating({ tenantId, ratingId, connection = getPrimaryPool(), forUpdate = false }) {
  const [rows] = await connection.execute(`${ratingSelect}
    WHERE pr.tenant_id = ? AND pr.id = ? AND pr.deleted_at IS NULL AND p.deleted_at IS NULL
    LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`, [uuidToBuffer(tenantId), uuidToBuffer(ratingId)]);
  return rows[0] ? mapRating(rows[0]) : null;
}

export async function updateRatingStatus({ ratingId, status, notes, actorUserId, connection }) {
  const [result] = await connection.execute(`UPDATE product_ratings SET status = ?, moderation_notes = ?,
    moderated_by = ?, moderated_at = UTC_TIMESTAMP(6) WHERE id = ? AND deleted_at IS NULL`,
  [status, notes || null, uuidToBuffer(actorUserId), uuidToBuffer(ratingId)]);
  return result.affectedRows === 1;
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action,
    entity_type, entity_id, request_id, ip_address, user_agent, before_data, after_data)
    VALUES (?, ?, ?, 'USER', ?, 'PRODUCT_RATING', ?, ?, INET6_ATON(?), ?, ?, ?)`,
  [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId), audit.action,
    uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress, audit.userAgent,
    JSON.stringify(audit.beforeData), JSON.stringify(audit.afterData)]);
}
