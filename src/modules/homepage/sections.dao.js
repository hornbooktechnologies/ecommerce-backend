import { getPrimaryPool } from "../../database/pool-factory.js";
import { uuidToBuffer } from "../../core/identifiers/uuid.js";

const parse = (value) => typeof value === "string" ? JSON.parse(value) : value;
export async function read({ tenantId, storeId, connection = getPrimaryPool() }) {
  const [[row]] = await connection.execute(`SELECT draft_json, published_json, revision, published_at
    FROM store_homepage_sections WHERE tenant_id = ? AND store_id = ?`, [uuidToBuffer(tenantId), uuidToBuffer(storeId)]);
  return row ? { draft: parse(row.draft_json), published: parse(row.published_json), revision: Number(row.revision), publishedAt: row.published_at } : null;
}
export async function saveDraft({ tenantId, storeId, document, connection }) {
  await connection.execute(`INSERT INTO store_homepage_sections (tenant_id, store_id, draft_json, revision)
    VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE draft_json = VALUES(draft_json), revision = revision + 1`,
  [uuidToBuffer(tenantId), uuidToBuffer(storeId), JSON.stringify(document)]);
}
export async function publish({ tenantId, storeId, connection }) {
  await connection.execute(`UPDATE store_homepage_sections SET published_json = draft_json,
    published_at = UTC_TIMESTAMP(6), revision = revision + 1 WHERE tenant_id = ? AND store_id = ?`,
  [uuidToBuffer(tenantId), uuidToBuffer(storeId)]);
}
