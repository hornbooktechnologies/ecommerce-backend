import { getPrimaryPool } from '../../database/pool-factory.js';
import {
  uuidToBuffer as id,
  bufferToUuid as uuid,
} from '../../core/identifiers/uuid.js';
const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const map = (row) =>
  row
    ? {
        id: uuid(row.id),
        slug: row.slug,
        draft: json(row.draft_json),
        published: json(row.published_json),
        visible: Boolean(row.is_visible),
        revision: Number(row.revision),
        publishedAt: row.published_at,
        updatedAt: row.updated_at,
      }
    : null;
export async function find({
  tenantId,
  storeId,
  collectionId,
  slug,
  connection = getPrimaryPool(),
}) {
  const [[row]] = await connection.execute(
    `SELECT * FROM store_collections WHERE tenant_id=? AND store_id=? AND ${collectionId ? 'id' : 'slug'}=?`,
    [id(tenantId), id(storeId), collectionId ? id(collectionId) : slug],
  );
  return map(row);
}
export async function list({
  tenantId,
  storeId,
  search = '',
  page = 1,
  pageSize = 10,
  publicOnly = false,
  connection = getPrimaryPool(),
}) {
  const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const where = `tenant_id=? AND store_id=? ${publicOnly ? 'AND is_visible=1 AND published_json IS NOT NULL' : ''} AND (slug LIKE ? ESCAPE '\\\\' OR JSON_UNQUOTE(JSON_EXTRACT(${publicOnly ? 'published_json' : 'draft_json'},'$.title')) LIKE ? ESCAPE '\\\\')`;
  const params = [id(tenantId), id(storeId), term, term];
  const [rows] = await connection.query(
    `SELECT * FROM store_collections WHERE ${where} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  const [[count]] = await connection.execute(
    `SELECT COUNT(*) total FROM store_collections WHERE ${where}`,
    params,
  );
  return {
    items: rows.map(map),
    total: Number(count.total),
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(Number(count.total) / pageSize)),
  };
}
export async function insert({
  tenantId,
  storeId,
  collectionId,
  slug,
  document,
  connection,
}) {
  await connection.execute(
    'INSERT INTO store_collections(id,tenant_id,store_id,slug,draft_json) VALUES(?,?,?,?,?)',
    [
      id(collectionId),
      id(tenantId),
      id(storeId),
      slug,
      JSON.stringify(document),
    ],
  );
}
export async function change({
  tenantId,
  storeId,
  collectionId,
  document,
  mode,
  connection,
}) {
  const clause =
    mode === 'publish'
      ? 'published_json=draft_json,is_visible=1,published_at=UTC_TIMESTAMP(6)'
      : mode === 'withdraw'
        ? 'is_visible=0'
        : 'draft_json=?';
  await connection.execute(
    `UPDATE store_collections SET ${clause},revision=revision+1 WHERE tenant_id=? AND store_id=? AND id=?`,
    [
      ...(mode === 'save' ? [JSON.stringify(document)] : []),
      id(tenantId),
      id(storeId),
      id(collectionId),
    ],
  );
}
