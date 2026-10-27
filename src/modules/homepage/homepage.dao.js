import { getPrimaryPool } from "../../database/pool-factory.js";
import { uuidToBuffer } from "../../core/identifiers/uuid.js";

const parse = (value) => typeof value === "string" ? JSON.parse(value) : value;
export async function readHero({ tenantId, storeId, connection = getPrimaryPool() }) {
  const [[row]] = await connection.execute(`SELECT draft_json, published_json, revision, published_at
    FROM store_homepage_heroes WHERE tenant_id = ? AND store_id = ?`, [uuidToBuffer(tenantId), uuidToBuffer(storeId)]);
  return row ? { draft: parse(row.draft_json), published: parse(row.published_json),
    revision: Number(row.revision), publishedAt: row.published_at } : null;
}
export async function saveDraft({ tenantId, storeId, document, connection }) {
  await connection.execute(`INSERT INTO store_homepage_heroes (tenant_id, store_id, draft_json, revision)
    VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE draft_json = VALUES(draft_json), revision = revision + 1`,
  [uuidToBuffer(tenantId), uuidToBuffer(storeId), JSON.stringify(document)]);
}
export async function publish({ tenantId, storeId, connection }) {
  await connection.execute(`UPDATE store_homepage_heroes SET published_json = draft_json,
    published_at = UTC_TIMESTAMP(6), revision = revision + 1 WHERE tenant_id = ? AND store_id = ?`,
  [uuidToBuffer(tenantId), uuidToBuffer(storeId)]);
}
export async function insertAsset({ id, tenantId, storeId, url, originalName, connection = getPrimaryPool() }) {
  await connection.execute(`INSERT INTO store_homepage_assets (id, tenant_id, store_id, url, original_name)
    VALUES (?, ?, ?, ?, ?)`, [uuidToBuffer(id), uuidToBuffer(tenantId), uuidToBuffer(storeId), url, originalName]);
}
export async function ownsAsset({ tenantId, storeId, url, connection = getPrimaryPool() }) {
  const [[row]] = await connection.execute(`SELECT id FROM store_homepage_assets
    WHERE tenant_id = ? AND store_id = ? AND url = ? LIMIT 1`, [uuidToBuffer(tenantId), uuidToBuffer(storeId), url]);
  return Boolean(row);
}
