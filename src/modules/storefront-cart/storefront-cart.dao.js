import { uuidToBuffer } from "../../core/identifiers/uuid.js";

const keys = ({ tenantId, storeId, ownerHash }) => [uuidToBuffer(tenantId), uuidToBuffer(storeId), ownerHash];

export async function ensure({ connection, customerId, ...scope }) {
  await connection.execute(`INSERT INTO storefront_carts
    (tenant_id, store_id, owner_hash, customer_id, items_json, expires_at)
    VALUES (?, ?, ?, ?, '[]', ${customerId ? "NULL" : "DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 DAY)"})
    ON DUPLICATE KEY UPDATE owner_hash = VALUES(owner_hash)`, [...keys(scope), customerId ? uuidToBuffer(customerId) : null]);
}

export async function read({ connection, ...scope }) {
  const [[row]] = await connection.execute(`SELECT revision, items_json, legacy_imported,
    (expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP(6)) AS expired
    FROM storefront_carts WHERE tenant_id = ? AND store_id = ? AND owner_hash = ? FOR UPDATE`, keys(scope));
  return row ? { revision: row.revision, items: typeof row.items_json === "string" ? JSON.parse(row.items_json) : row.items_json,
    legacyImported: Boolean(row.legacy_imported), expired: Boolean(row.expired) } : null;
}

export async function save({ connection, items, legacyImported, ...scope }) {
  await connection.execute(`UPDATE storefront_carts SET items_json = ?, revision = revision + 1,
    legacy_imported = ?, updated_at = UTC_TIMESTAMP(6) WHERE tenant_id = ? AND store_id = ? AND owner_hash = ?`,
  [JSON.stringify(items), Number(legacyImported), ...keys(scope)]);
}

export async function prune({ connection }) {
  await connection.execute("DELETE FROM storefront_carts WHERE expires_at <= UTC_TIMESTAMP(6) LIMIT 100");
}
