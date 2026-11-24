import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid } from "../../core/identifiers/uuid.js";

// Accept only action/entity pairs emitted by platform tenant and access services.
// In particular a tenant's own team/role audits never belong in this feed.
const scope = `((a.entity_type='TENANT' AND a.tenant_id=a.entity_id AND a.action IN
  ('platform.tenant.created','platform.tenant.updated','platform.tenant.activated','platform.tenant.suspended','platform.tenant.restored'))
 OR (a.entity_type='PLATFORM_USER' AND a.tenant_id IS NULL AND a.action IN
  ('platform.user.invited','platform.user.active','platform.user.suspended','platform.role.assigned'))
 OR (a.entity_type='PLATFORM_ROLE' AND a.tenant_id IS NULL AND a.action IN
  ('platform.role.created','platform.role.updated','platform.role.deleted')))`;
const joins = `FROM audit_logs a
 LEFT JOIN users actor ON actor.id=a.actor_user_id
 LEFT JOIN tenants t ON a.entity_type='TENANT' AND t.id=a.entity_id
 LEFT JOIN users member ON a.entity_type='PLATFORM_USER' AND member.id=a.entity_id
 LEFT JOIN roles r ON a.entity_type='PLATFORM_ROLE' AND r.id=a.entity_id AND r.role_level='PLATFORM' AND r.tenant_id IS NULL`;
const name = alias => `NULLIF(TRIM(CONCAT_WS(' ',${alias}.first_name,${alias}.last_name)), '')`;
const target = `COALESCE(t.display_name,${name("member")},r.name)`;
const fields = { TENANT: ["code","displayName","legalName","status","timezone","catalogVerticals"],
  PLATFORM_ROLE: ["name","permissionKeys"], PLATFORM_USER: ["status","roleIds"] };

function snapshot(raw) {
  if (typeof raw !== "string") return raw || {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}
function safeValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every(v => typeof v === "string")) return [...value].sort().join(", ");
  return null;
}
export function projectEvent(row) {
  const before = snapshot(row.before_data), after = snapshot(row.after_data);
  const changes = [];
  for (const field of fields[row.entity_type] || []) {
    const from = safeValue(before[field]), to = safeValue(after[field]);
    if (from !== to) changes.push({ field, from, to });
  }
  return { id: bufferToUuid(row.id), occurredAt: row.occurred_at, action: row.action,
    area: row.entity_type, actor: row.actor_name || null, target: row.target_name || bufferToUuid(row.entity_id), changes };
}

export async function listAuditEvents({ search, area, page, pageSize }, connection = getPrimaryPool()) {
  const conditions = [scope], args = [];
  if (area !== "ALL") { conditions.push("a.entity_type=?"); args.push(area); }
  if (search) {
    // LOCATE treats percent and underscore as ordinary user input.
    conditions.push(`LOCATE(LOWER(?),LOWER(CONCAT_WS(' ',a.action,REPLACE(a.action,'.',' '),${name("actor")},${target},t.code)))>0`);
    args.push(search);
  }
  const source = `${joins} WHERE ${conditions.join(" AND ")}`;
  const [[count]] = await connection.execute(`SELECT COUNT(*) AS total ${source}`, args);
  const total = Number(count.total), totalPages = Math.max(1, Math.ceil(total/pageSize));
  const actualPage = Math.min(page, totalPages);
  const [rows] = await connection.execute(`SELECT a.id,a.occurred_at,a.action,a.entity_type,a.entity_id,
    a.before_data,a.after_data,${name("actor")} AS actor_name,${target} AS target_name
    ${source} ORDER BY a.occurred_at DESC,a.id DESC LIMIT ? OFFSET ?`,
    [...args,pageSize,(actualPage-1)*pageSize]);
  return { items: rows.map(projectEvent), total, totalPages, page: actualPage, pageSize };
}
