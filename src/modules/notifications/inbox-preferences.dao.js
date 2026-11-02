import { getPrimaryPool } from "../../database/pool-factory.js";
import { createId, uuidToBuffer as id } from "../../core/identifiers/uuid.js";

const scopeValues = (scope) => [id(scope.tenantId), scope.audience, id(scope.recipientId),
  scope.audience === "CUSTOMER" ? id(scope.storeId) : Buffer.alloc(16)];
export async function lockPrincipal({ scope, connection }) {
  const [rows] = scope.audience === "CUSTOMER"
    ? await connection.execute("SELECT id FROM customers WHERE tenant_id = ? AND id = ? AND status = 'ACTIVE' AND deleted_at IS NULL FOR UPDATE", [id(scope.tenantId), id(scope.recipientId)])
    : await connection.execute("SELECT id FROM users WHERE id = ? AND status = 'ACTIVE' AND deleted_at IS NULL FOR UPDATE", [id(scope.recipientId)]);
  return rows.length === 1;
}
export async function read({ scope, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT disabled_categories, revision FROM inbox_preferences
    WHERE tenant_id = ? AND audience = ? AND recipient_id = ? AND store_scope = ?`, scopeValues(scope));
  return rows[0] ? { disabledCategories: typeof rows[0].disabled_categories === "string" ? JSON.parse(rows[0].disabled_categories) : rows[0].disabled_categories,
    revision: Number(rows[0].revision) } : null;
}
export async function save({ scope, disabledCategories, connection }) {
  await connection.execute(`INSERT INTO inbox_preferences (tenant_id, audience, recipient_id, store_scope, disabled_categories)
    VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE disabled_categories = VALUES(disabled_categories), revision = revision + 1`,
  [...scopeValues(scope), JSON.stringify(disabledCategories)]);
}
export async function audit({ scope, disabledCategories, revision, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type, entity_id, after_data)
    VALUES (?, ?, ?, ?, 'notification.preferences.updated', 'INBOX_PREFERENCES', ?, ?)`,
  [id(createId()), id(scope.tenantId), scope.audience === "ADMIN" ? id(scope.recipientId) : null,
    scope.audience === "ADMIN" ? "USER" : "CUSTOMER", id(scope.recipientId),
    JSON.stringify({ audience: scope.audience, storeId: scope.storeId || null, disabledCategories, revision })]);
}
