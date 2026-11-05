import { getPrimaryPool } from "../../database/pool-factory.js";
import { uuidToBuffer as id, createId } from "../../core/identifiers/uuid.js";
const json = (value) => (typeof value === "string" ? JSON.parse(value) : value);
export async function store({
  tenantId,
  storeId,
  connection = getPrimaryPool(),
  lock = false,
}) {
  const [[row]] = await connection.execute(
    `SELECT id,base_currency FROM stores WHERE tenant_id=? AND id=? AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`,
    [id(tenantId), id(storeId)],
  );
  return row || null;
}
export async function find({
  tenantId,
  storeId,
  connection = getPrimaryPool(),
}) {
  const [[row]] = await connection.execute(
    "SELECT * FROM store_localization WHERE tenant_id=? AND store_id=?",
    [id(tenantId), id(storeId)],
  );
  return row
    ? {
        defaultLanguage: row.default_language,
        languages: json(row.languages_json),
        currencies: json(row.currencies_json),
        rates: json(row.rates_json),
        revision: Number(row.revision),
      }
    : null;
}
export async function save({ tenantId, storeId, input, context, connection }) {
  await connection.execute(
    `INSERT INTO store_localization(tenant_id,store_id,default_language,languages_json,currencies_json,rates_json,updated_by)
 VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE default_language=VALUES(default_language),languages_json=VALUES(languages_json),currencies_json=VALUES(currencies_json),rates_json=VALUES(rates_json),updated_by=VALUES(updated_by),revision=revision+1`,
    [
      id(tenantId),
      id(storeId),
      input.defaultLanguage,
      JSON.stringify(input.languages),
      JSON.stringify(input.currencies),
      JSON.stringify(input.rates),
      id(context.actorUserId),
    ],
  );
  await connection.execute(
    `INSERT INTO audit_logs(id,tenant_id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,after_data)
 VALUES(?,?,?,'USER','STORE_LOCALIZATION_UPDATED','STORE',?,?,?)`,
    [
      id(createId()),
      id(tenantId),
      id(context.actorUserId),
      id(storeId),
      context.requestId || null,
      JSON.stringify(input),
    ],
  );
}
