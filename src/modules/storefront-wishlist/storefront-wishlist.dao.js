import { uuidToBuffer } from "../../core/identifiers/uuid.js";
const keys = ({ tenantId, storeId, ownerHash }) => [uuidToBuffer(tenantId), uuidToBuffer(storeId), ownerHash];

export async function ensure({ connection, customerId, ...scope }) {
  await connection.execute(`INSERT INTO storefront_wishlists
    (tenant_id, store_id, owner_hash, customer_id, product_ids_json, expires_at)
    VALUES (?, ?, ?, ?, '[]', ${customerId ? "NULL" : "DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 DAY)"})
    ON DUPLICATE KEY UPDATE owner_hash = VALUES(owner_hash)`, [...keys(scope), customerId ? uuidToBuffer(customerId) : null]);
}
export async function read({ connection, ...scope }) {
  const [[row]] = await connection.execute(`SELECT revision, product_ids_json, legacy_imported, consumed_at,
    (expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP(6)) AS expired
    FROM storefront_wishlists WHERE tenant_id = ? AND store_id = ? AND owner_hash = ? FOR UPDATE`, keys(scope));
  return row ? { revision: Number(row.revision), productIds: typeof row.product_ids_json === "string" ? JSON.parse(row.product_ids_json) : row.product_ids_json,
    legacyImported: Boolean(row.legacy_imported), consumed: Boolean(row.consumed_at), expired: Boolean(row.expired) } : null;
}
export async function save({ connection, productIds, legacyImported, ...scope }) {
  await connection.execute(`UPDATE storefront_wishlists SET product_ids_json = ?, legacy_imported = ?, revision = revision + 1,
    updated_at = UTC_TIMESTAMP(6) WHERE tenant_id = ? AND store_id = ? AND owner_hash = ?`, [JSON.stringify(productIds), Number(legacyImported), ...keys(scope)]);
}
export async function consume({ connection, ...scope }) {
  await connection.execute(`UPDATE storefront_wishlists SET product_ids_json = '[]', consumed_at = UTC_TIMESTAMP(6),
    revision = revision + 1 WHERE tenant_id = ? AND store_id = ? AND owner_hash = ? AND customer_id IS NULL`, keys(scope));
}
