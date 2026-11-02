import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid, uuidToBuffer as id, createId } from "../../core/identifiers/uuid.js";

const map = (row) => row ? ({ id: bufferToUuid(row.id), storeId: bufferToUuid(row.store_id), email: row.email,
  status: row.status, consentVersion: row.consent_version, consentRequestedAt: row.consent_requested_at,
  confirmedAt: row.confirmed_at, unsubscribedAt: row.unsubscribed_at, confirmationDelivery: row.confirmation_delivery,
  revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at,
  ...(row.store_name ? { storeName: row.store_name, storeCode: row.store_code } : {}) }) : null;

// Unsubscribe links remain usable even when the tenant/store is inactive.
export async function resolveUnsubscribeStore({ tenantCode, storeCode, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT t.id AS tenant_id, s.id AS store_id FROM tenants t
    JOIN stores s ON s.tenant_id = t.id WHERE t.code = ? AND s.code = ? LIMIT 1`, [tenantCode, storeCode]);
  return rows[0] ? { tenantId: bufferToUuid(rows[0].tenant_id), storeId: bufferToUuid(rows[0].store_id) } : null;
}
export async function lockStore({ tenantId, storeId, allowInactive = false, connection }) {
  const [rows] = await connection.execute(`SELECT s.id FROM stores s JOIN tenants t ON t.id = s.tenant_id
    WHERE s.tenant_id = ? AND s.id = ?${allowInactive ? "" : " AND s.status = 'ACTIVE' AND s.deleted_at IS NULL AND t.status = 'ACTIVE' AND t.deleted_at IS NULL"} FOR UPDATE`,
  [id(tenantId), id(storeId)]);
  return rows.length === 1;
}
export async function findSubscriber({ tenantId, storeId, email, subscriberId, connection, lock = true }) {
  const [rows] = await connection.execute(`SELECT * FROM newsletter_subscribers WHERE tenant_id = ?
    ${storeId ? "AND store_id = ?" : ""} AND ${subscriberId ? "id = ?" : "email = ?"}${lock ? " FOR UPDATE" : ""}`,
  [id(tenantId), ...(storeId ? [id(storeId)] : []), subscriberId ? id(subscriberId) : email]);
  return map(rows[0]);
}
export async function requestConfirmation({ scope, subscriberId, email, confirmHash, unsubscribeHash, consentVersion, exists, connection }) {
  if (exists) {
    await connection.execute(`UPDATE newsletter_subscribers SET status = 'PENDING', consent_version = ?,
      consent_requested_at = UTC_TIMESTAMP(6), confirmed_at = NULL, confirm_token_hash = ?,
      confirm_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 MINUTE), unsubscribe_token_hash = ?,
      confirmation_delivery = 'PENDING', revision = revision + 1 WHERE tenant_id = ? AND store_id = ? AND id = ?`,
    [consentVersion, confirmHash, unsubscribeHash, id(scope.tenantId), id(scope.storeId), id(subscriberId)]);
  } else {
    await connection.execute(`INSERT INTO newsletter_subscribers
      (id, tenant_id, store_id, email, consent_version, confirm_token_hash, confirm_expires_at, unsubscribe_token_hash)
      VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 MINUTE), ?)`,
    [id(subscriberId), id(scope.tenantId), id(scope.storeId), email, consentVersion, confirmHash, unsubscribeHash]);
  }
}
export async function recordDelivery({ scope, subscriberId, confirmHash, sent, connection = getPrimaryPool() }) {
  // Do not let a slow, older SMTP request overwrite a newer confirmation or unsubscribe.
  await connection.execute(`UPDATE newsletter_subscribers SET confirmation_delivery = ?,
    confirm_token_hash = IF(?, confirm_token_hash, NULL), confirm_expires_at = IF(?, confirm_expires_at, NULL)
    WHERE tenant_id = ? AND store_id = ? AND id = ? AND status = 'PENDING' AND confirm_token_hash = ?`,
  [sent ? "SENT" : "FAILED", sent, sent, id(scope.tenantId), id(scope.storeId), id(subscriberId), confirmHash]);
}
export async function findToken({ scope, tokenHash, unsubscribe = false, connection }) {
  const [rows] = await connection.execute(`SELECT *, COALESCE(confirm_expires_at > UTC_TIMESTAMP(6), 0) AS token_current
    FROM newsletter_subscribers WHERE tenant_id = ? AND store_id = ?
      AND ${unsubscribe ? "unsubscribe_token_hash" : "confirm_token_hash"} = ? FOR UPDATE`,
  [id(scope.tenantId), id(scope.storeId), tokenHash]);
  return rows[0] ? { ...map(rows[0]), tokenCurrent: Number(rows[0].token_current) === 1 } : null;
}
export async function activate({ scope, subscriberId, connection }) {
  await connection.execute(`UPDATE newsletter_subscribers SET status = 'ACTIVE', confirmed_at = UTC_TIMESTAMP(6),
    unsubscribed_at = NULL, confirmation_delivery = 'SENT', revision = revision + 1
    WHERE tenant_id = ? AND store_id = ? AND id = ? AND status = 'PENDING'`,
  [id(scope.tenantId), id(scope.storeId), id(subscriberId)]);
}
export async function unsubscribe({ tenantId, subscriberId, connection }) {
  await connection.execute(`UPDATE newsletter_subscribers SET status = 'UNSUBSCRIBED', unsubscribed_at = UTC_TIMESTAMP(6),
    confirm_token_hash = NULL, confirm_expires_at = NULL, revision = revision + 1 WHERE tenant_id = ? AND id = ?`,
  [id(tenantId), id(subscriberId)]);
}
export async function audit({ tenantId, subscriberId, action, context, data, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action,
    entity_type, entity_id, request_id, after_data) VALUES (?, ?, ?, ?, ?, 'NEWSLETTER_SUBSCRIBER', ?, ?, ?)`,
  [id(createId()), id(tenantId), context?.actorUserId ? id(context.actorUserId) : null,
    context?.actorUserId ? "USER" : "SYSTEM", action, id(subscriberId), context?.requestId || null, JSON.stringify(data)]);
}
export async function listSubscribers({ tenantId, filters, connection = getPrimaryPool() }) {
  const conditions = ["n.tenant_id = ?"]; const values = [id(tenantId)];
  if (filters.storeId) { conditions.push("n.store_id = ?"); values.push(id(filters.storeId)); }
  if (filters.status !== "ALL") { conditions.push("n.status = ?"); values.push(filters.status); }
  if (filters.search) { conditions.push("LOCATE(?, n.email) > 0"); values.push(filters.search); }
  const where = conditions.join(" AND ");
  const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM newsletter_subscribers n WHERE ${where}`, values);
  const total = Number(count.total); const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  const page = Math.min(filters.page, totalPages);
  const [rows] = await connection.execute(`SELECT n.*, s.name AS store_name, s.code AS store_code
    FROM newsletter_subscribers n JOIN stores s ON s.tenant_id = n.tenant_id AND s.id = n.store_id
    WHERE ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`,
  [...values, filters.pageSize, (page - 1) * filters.pageSize]);
  const [stores] = await connection.execute("SELECT id, name, code FROM stores WHERE tenant_id = ? ORDER BY name", [id(tenantId)]);
  return { items: rows.map(map), total, page, pageSize: filters.pageSize, totalPages,
    stores: stores.map((store) => ({ id: bufferToUuid(store.id), name: store.name, code: store.code })) };
}
