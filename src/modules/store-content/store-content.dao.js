import { getPrimaryPool } from "../../database/pool-factory.js";
import { createId, bufferToUuid, uuidToBuffer as id } from "../../core/identifiers/uuid.js";

const json = (value) => typeof value === "string" ? JSON.parse(value) : value;
export async function listStores({ tenantId, search, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT id, name, code, status FROM stores
    WHERE tenant_id = ? AND deleted_at IS NULL AND (? = '' OR LOCATE(?, name) > 0 OR LOCATE(?, code) > 0)
    ORDER BY status = 'ACTIVE' DESC, name, id LIMIT 51`, [id(tenantId), search, search, search]);
  return { items: rows.slice(0, 50).map((row) => ({ id: bufferToUuid(row.id), name: row.name, code: row.code, status: row.status })),
    hasMore: rows.length > 50 };
}
export async function findStore({ tenantId, storeId, lock = false, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT id, name, code, status FROM stores
    WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`, [id(tenantId), id(storeId)]);
  return rows[0] ? { id: bufferToUuid(rows[0].id), name: rows[0].name, code: rows[0].code, status: rows[0].status } : null;
}
export async function read({ tenantId, storeId, pageKey, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT id, draft_document, published_document, revision, published_revision, published_at, updated_at
    FROM store_content_pages WHERE tenant_id = ? AND store_id = ? AND page_key = ?`, [id(tenantId), id(storeId), pageKey]);
  const row = rows[0];
  return row ? { id: bufferToUuid(row.id), draft: json(row.draft_document), published: json(row.published_document),
    revision: Number(row.revision), publishedRevision: row.published_revision === null ? null : Number(row.published_revision),
    publishedAt: row.published_at, updatedAt: row.updated_at } : null;
}
export async function save({ tenantId, storeId, pageKey, pageId, document, exists, actorUserId, connection }) {
  if (exists) await connection.execute(`UPDATE store_content_pages SET draft_document = ?, revision = revision + 1, updated_by = ?
    WHERE tenant_id = ? AND store_id = ? AND page_key = ?`,
  [JSON.stringify(document), id(actorUserId), id(tenantId), id(storeId), pageKey]);
  else await connection.execute(`INSERT INTO store_content_pages (id, tenant_id, store_id, page_key, draft_document, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)`, [id(pageId), id(tenantId), id(storeId), pageKey, JSON.stringify(document), id(actorUserId)]);
}
export async function publish({ tenantId, storeId, pageKey, actorUserId, connection }) {
  await connection.execute(`UPDATE store_content_pages SET published_document = draft_document, published_revision = revision + 1,
    revision = revision + 1, published_at = UTC_TIMESTAMP(6), published_by = ?, updated_by = ?
    WHERE tenant_id = ? AND store_id = ? AND page_key = ?`,
  [id(actorUserId), id(actorUserId), id(tenantId), id(storeId), pageKey]);
}
export async function withdraw({ tenantId, storeId, pageKey, actorUserId, connection }) {
  await connection.execute(`UPDATE store_content_pages SET published_document = NULL, published_revision = NULL,
    published_at = NULL, published_by = NULL, revision = revision + 1, updated_by = ?
    WHERE tenant_id = ? AND store_id = ? AND page_key = ?`, [id(actorUserId), id(tenantId), id(storeId), pageKey]);
}
export async function audit({ tenantId, storeId, pageKey, pageId, action, revision, context, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type,
    entity_id, request_id, after_data) VALUES (?, ?, ?, 'USER', ?, 'STORE_CONTENT_PAGE', ?, ?, ?)`,
  [id(createId()), id(tenantId), id(context.actorUserId), action, id(pageId), context.requestId || null,
    JSON.stringify({ storeId, pageKey, revision })]);
}
export async function publicIndex({ tenantId, storeId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT page_key, JSON_UNQUOTE(JSON_EXTRACT(published_document, '$.title')) AS title, published_at
    FROM store_content_pages WHERE tenant_id = ? AND store_id = ? AND published_document IS NOT NULL`, [id(tenantId), id(storeId)]);
  return rows.map((row) => ({ key: row.page_key, title: row.title, publishedAt: row.published_at }));
}
export async function publicRead({ tenantId, storeId, pageKey, connection = getPrimaryPool() }) {
  // This query must never select the draft, editor IDs or private audit data.
  const [rows] = await connection.execute(`SELECT published_document, published_at FROM store_content_pages
    WHERE tenant_id = ? AND store_id = ? AND page_key = ? AND published_document IS NOT NULL`,
  [id(tenantId), id(storeId), pageKey]);
  return rows[0] ? { document: json(rows[0].published_document), publishedAt: rows[0].published_at } : null;
}
