import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

const number = (value) => Number(value || 0);
const iso = (value) => value instanceof Date ? value.toISOString() : value;
const escapeSearch = (value) => value.replace(/[\\%_]/g, (character) => `\\${character}`);
function json(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function lifecycle(row) {
  const now = Date.now();
  if (row.status === "ACTIVE" && row.starts_at && new Date(row.starts_at).getTime() > now) return "SCHEDULED";
  if (["ACTIVE", "PAUSED"].includes(row.status) && row.ends_at && new Date(row.ends_at).getTime() < now) return "EXPIRED";
  return row.status;
}

function mapPromotion(row) {
  const conditions = json(row.conditions_json);
  const actions = json(row.actions_json);
  return { id: bufferToUuid(row.id), name: row.name, type: row.promotion_type,
    status: lifecycle(row), storedStatus: row.status, storeId: bufferToUuid(row.store_id),
    storeName: row.store_name || "All stores", priority: number(row.priority), stackable: Boolean(row.stackable),
    startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), usageLimitTotal: row.usage_limit_total === null ? null : number(row.usage_limit_total),
    usageLimitPerCustomer: row.usage_limit_per_customer === null ? null : number(row.usage_limit_per_customer),
    minimumOrderAmount: number(conditions.minimumOrderAmount), couponRequired: Boolean(conditions.couponRequired),
    discountValue: number(actions.discountValue), maxDiscountAmount: actions.maxDiscountAmount === null || actions.maxDiscountAmount === undefined ? null : number(actions.maxDiscountAmount),
    couponCount: number(row.coupon_count), activeCouponCount: number(row.active_coupon_count),
    redemptionCount: number(row.redemption_count), discountTotal: number(row.discount_total),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function mapCoupon(row) {
  return { id: bufferToUuid(row.id), code: row.code, status: row.status,
    usageLimit: row.usage_limit === null ? null : number(row.usage_limit), usageCount: number(row.usage_count),
    redemptionCount: number(row.redemption_count), startsAt: iso(row.starts_at), endsAt: iso(row.ends_at),
    createdAt: iso(row.created_at) };
}

const promotionSelect = `SELECT p.*, s.name AS store_name,
  (SELECT COUNT(*) FROM coupons c WHERE c.promotion_id = p.id) AS coupon_count,
  (SELECT COUNT(*) FROM coupons c WHERE c.promotion_id = p.id AND c.status = 'ACTIVE') AS active_coupon_count,
  (SELECT COUNT(*) FROM promotion_redemptions pr WHERE pr.promotion_id = p.id AND pr.reversed_at IS NULL) AS redemption_count,
  (SELECT COALESCE(SUM(pr.discount_amount), 0) FROM promotion_redemptions pr WHERE pr.promotion_id = p.id AND pr.reversed_at IS NULL) AS discount_total
  FROM promotions p LEFT JOIN stores s ON s.id = p.store_id`;

export async function listPromotions({ tenantId, filters, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId); const where = ["p.tenant_id = ?", "p.deleted_at IS NULL"]; const params = [tenant];
  if (filters.search) { const term = `%${escapeSearch(filters.search)}%`; where.push(`(p.name LIKE ? ESCAPE '\\\\' OR EXISTS
    (SELECT 1 FROM coupons search_coupon WHERE search_coupon.promotion_id = p.id AND search_coupon.code LIKE ? ESCAPE '\\\\'))`); params.push(term, term); }
  if (filters.type !== "ALL") { where.push("p.promotion_type = ?"); params.push(filters.type); }
  if (filters.status === "ACTIVE") where.push("p.status = 'ACTIVE' AND p.starts_at <= UTC_TIMESTAMP(6) AND (p.ends_at IS NULL OR p.ends_at >= UTC_TIMESTAMP(6))");
  else if (filters.status === "SCHEDULED") where.push("p.status = 'ACTIVE' AND p.starts_at > UTC_TIMESTAMP(6)");
  else if (filters.status === "EXPIRED") where.push("p.status IN ('ACTIVE', 'PAUSED') AND p.ends_at IS NOT NULL AND p.ends_at < UTC_TIMESTAMP(6)");
  else if (filters.status !== "ALL") { where.push("p.status = ?"); params.push(filters.status); }
  const clause = where.join(" AND "); const offset = (filters.page - 1) * filters.pageSize;
  const [rowsResult, countResult, summaryResult] = await Promise.all([
    connection.execute(`${promotionSelect} WHERE ${clause} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`, [...params, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total FROM promotions p WHERE ${clause}`, params),
    connection.execute(`SELECT COUNT(*) AS total,
      SUM(p.status = 'ACTIVE' AND p.starts_at <= UTC_TIMESTAMP(6) AND (p.ends_at IS NULL OR p.ends_at >= UTC_TIMESTAMP(6))) AS active,
      SUM(p.status = 'ACTIVE' AND p.starts_at > UTC_TIMESTAMP(6)) AS scheduled,
      SUM(p.status = 'DRAFT') AS draft,
      (SELECT COUNT(*) FROM promotion_redemptions pr WHERE pr.tenant_id = ? AND pr.reversed_at IS NULL) AS redemptions,
      (SELECT COALESCE(SUM(pr.discount_amount), 0) FROM promotion_redemptions pr WHERE pr.tenant_id = ? AND pr.reversed_at IS NULL) AS discount_total
      FROM promotions p WHERE p.tenant_id = ? AND p.deleted_at IS NULL`, [tenant, tenant, tenant])
  ]);
  const total = number(countResult[0][0].total); const summary = summaryResult[0][0];
  return { items: rowsResult[0].map(mapPromotion), total, page: filters.page, pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)), summary: { total: number(summary.total), active: number(summary.active),
      scheduled: number(summary.scheduled), draft: number(summary.draft), redemptions: number(summary.redemptions), discountTotal: number(summary.discount_total) } };
}

export async function getPromotion({ tenantId, promotionId, connection = getPrimaryPool(), forUpdate = false }) {
  const [rows] = await connection.execute(`${promotionSelect} WHERE p.tenant_id = ? AND p.id = ? AND p.deleted_at IS NULL LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(promotionId)]);
  return rows[0] ? mapPromotion(rows[0]) : null;
}

export async function getPromotionDetails({ tenantId, promotionId, connection = getPrimaryPool() }) {
  const promotion = await getPromotion({ tenantId, promotionId, connection }); if (!promotion) return null;
  const tenant = uuidToBuffer(tenantId); const id = uuidToBuffer(promotionId);
  const [couponResult, redemptionResult] = await Promise.all([
    connection.execute(`SELECT c.*, (SELECT COUNT(*) FROM promotion_redemptions pr WHERE pr.coupon_id = c.id AND pr.reversed_at IS NULL) AS redemption_count
      FROM coupons c WHERE c.tenant_id = ? AND c.promotion_id = ? ORDER BY c.created_at DESC`, [tenant, id]),
    connection.execute(`SELECT pr.id, pr.discount_amount, pr.redeemed_at, co.order_number,
      CONCAT(cu.first_name, IF(cu.last_name IS NULL OR cu.last_name = '', '', CONCAT(' ', cu.last_name))) AS customer_name,
      cp.code AS coupon_code FROM promotion_redemptions pr JOIN customer_orders co ON co.id = pr.customer_order_id
      LEFT JOIN customers cu ON cu.id = pr.customer_id LEFT JOIN coupons cp ON cp.id = pr.coupon_id
      WHERE pr.tenant_id = ? AND pr.promotion_id = ? AND pr.reversed_at IS NULL ORDER BY pr.redeemed_at DESC LIMIT 20`, [tenant, id])
  ]);
  return { promotion, coupons: couponResult[0].map(mapCoupon), redemptions: redemptionResult[0].map((row) => ({
    id: bufferToUuid(row.id), orderNumber: row.order_number, customerName: row.customer_name || "Guest customer",
    couponCode: row.coupon_code || "Automatic", discountAmount: number(row.discount_amount), redeemedAt: iso(row.redeemed_at) })) };
}

export async function listOptions({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT id, code, name FROM stores WHERE tenant_id = ? AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY name`, [uuidToBuffer(tenantId)]);
  return { stores: rows.map((row) => ({ id: bufferToUuid(row.id), code: row.code, name: row.name })) };
}

export async function storeExists({ tenantId, storeId, connection }) {
  if (!storeId) return true;
  const [rows] = await connection.execute(`SELECT id FROM stores WHERE tenant_id = ? AND id = ? AND status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1`, [uuidToBuffer(tenantId), uuidToBuffer(storeId)]);
  return Boolean(rows[0]);
}

export async function insertPromotion({ promotion, connection }) {
  await connection.execute(`INSERT INTO promotions (id, tenant_id, store_id, name, promotion_type, status, priority, stackable, starts_at, ends_at,
    usage_limit_total, usage_limit_per_customer, conditions_json, actions_json, created_by) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [uuidToBuffer(promotion.id), uuidToBuffer(promotion.tenantId), promotion.storeId ? uuidToBuffer(promotion.storeId) : null,
    promotion.name, promotion.type, promotion.priority, promotion.stackable ? 1 : 0, promotion.startsAt, promotion.endsAt,
    promotion.usageLimitTotal, promotion.usageLimitPerCustomer, JSON.stringify(promotion.conditions), JSON.stringify(promotion.actions), uuidToBuffer(promotion.createdBy)]);
}

export async function updatePromotion({ promotionId, input, connection }) {
  const [result] = await connection.execute(`UPDATE promotions SET store_id = ?, name = ?, promotion_type = ?, priority = ?, stackable = ?, starts_at = ?, ends_at = ?,
    usage_limit_total = ?, usage_limit_per_customer = ?, conditions_json = ?, actions_json = ? WHERE id = ? AND deleted_at IS NULL`,
  [input.storeId ? uuidToBuffer(input.storeId) : null, input.name, input.type, input.priority, input.stackable ? 1 : 0,
    input.startsAt, input.endsAt, input.usageLimitTotal, input.usageLimitPerCustomer,
    JSON.stringify(input.conditions), JSON.stringify(input.actions), uuidToBuffer(promotionId)]);
  return result.affectedRows === 1;
}

export async function setPromotionStatus({ promotionId, status, connection }) {
  const [result] = await connection.execute(`UPDATE promotions SET status = ? WHERE id = ? AND deleted_at IS NULL`, [status, uuidToBuffer(promotionId)]);
  return result.affectedRows === 1;
}

export async function insertCoupon({ coupon, connection }) {
  await connection.execute(`INSERT INTO coupons (id, tenant_id, promotion_id, code, status, usage_limit, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(coupon.id), uuidToBuffer(coupon.tenantId), uuidToBuffer(coupon.promotionId), coupon.code, coupon.status,
      coupon.usageLimit, coupon.startsAt, coupon.endsAt]);
}

export async function getCoupon({ tenantId, promotionId, couponId, connection, forUpdate = false }) {
  const [rows] = await connection.execute(`SELECT c.*, 0 AS redemption_count FROM coupons c WHERE c.tenant_id = ? AND c.promotion_id = ? AND c.id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(promotionId), uuidToBuffer(couponId)]);
  return rows[0] ? mapCoupon(rows[0]) : null;
}

export async function findCouponByCode({ tenantId, promotionId, code, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT c.*, 0 AS redemption_count FROM coupons c WHERE c.tenant_id = ? AND c.promotion_id = ? AND c.code = ? LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(promotionId), code]);
  return rows[0] ? mapCoupon(rows[0]) : null;
}

export async function updateCoupon({ couponId, input, connection }) {
  const [result] = await connection.execute(`UPDATE coupons SET code = ?, status = ?, usage_limit = ?, starts_at = ?, ends_at = ? WHERE id = ?`,
    [input.code, input.status, input.usageLimit, input.startsAt, input.endsAt, uuidToBuffer(couponId)]);
  return result.affectedRows === 1;
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, ip_address, user_agent, before_data, after_data)
    VALUES (?, ?, ?, 'USER', ?, ?, ?, ?, INET6_ATON(?), ?, ?, ?)`,
  [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId), audit.action, audit.entityType,
    uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress, audit.userAgent, JSON.stringify(audit.beforeData), JSON.stringify(audit.afterData)]);
}
