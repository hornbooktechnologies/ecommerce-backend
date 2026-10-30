import { getPrimaryPool } from "../../database/pool-factory.js";
import { createId, uuidToBuffer as id, bufferToUuid as uuid } from "../../core/identifiers/uuid.js";

const iso = (value) => value instanceof Date ? value.toISOString() : value;
const metadata = (row) => ({
  id: uuid(row.id), tenantCode: row.tenant_code, kind: row.kind, audience: row.audience,
  status: row.status, attempts: Number(row.attempt_count), manualRetries: Number(row.manual_retry_count),
  recipientCount: Number(row.recipient_count), processedRecipients: Number(row.recipient_offset),
  createdAt: iso(row.created_at), nextAttemptAt: iso(row.next_attempt_at),
  processedAt: iso(row.processed_at), lastManualRetryAt: iso(row.last_manual_retry_at),
  failureCode: row.last_error ? (row.last_error === "INBOX_DELIVERY_FAILED" ? row.last_error : "DELIVERY_FAILED") : null
});

export async function list({ filters, connection = getPrimaryPool() }) {
  const clauses = [], values = [];
  if (filters.status !== "ALL") { clauses.push("e.status = ?"); values.push(filters.status); }
  if (filters.audience !== "ALL") { clauses.push("e.audience = ?"); values.push(filters.audience); }
  if (filters.search) {
    clauses.push("(LOCATE(?, t.code) > 0 OR LOCATE(?, e.kind) > 0)");
    values.push(filters.search, filters.search);
  }
  const from = `FROM inbox_events e JOIN tenants t ON t.id = e.tenant_id ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`;
  const [[count]] = await connection.execute(`SELECT COUNT(*) AS total ${from}`, values);
  const total = Number(count.total), totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  const page = Math.min(filters.page, totalPages);
  const [rows] = await connection.execute(`SELECT e.id, t.code AS tenant_code, e.kind, e.audience,
    e.status, e.attempt_count, e.manual_retry_count, e.recipient_offset, JSON_LENGTH(e.recipients) AS recipient_count,
    e.created_at, e.next_attempt_at, e.processed_at, e.last_manual_retry_at, e.last_error
    ${from} ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
  [...values, filters.pageSize, (page - 1) * filters.pageSize]);
  const [counts] = await connection.execute("SELECT status, COUNT(*) AS total FROM inbox_events GROUP BY status");
  return { items: rows.map(metadata), page, pageSize: filters.pageSize, total, totalPages,
    summary: Object.fromEntries(counts.map((row) => [row.status, Number(row.total)])) };
}

export async function lock({ eventId, connection }) {
  const [[row]] = await connection.execute(`SELECT id, tenant_id, status, attempt_count, manual_retry_count,
    recipients, recipient_offset FROM inbox_events WHERE id = ? FOR UPDATE`, [id(eventId)]);
  return row || null;
}

export async function queueRetry({ eventId, connection }) {
  await connection.execute(`UPDATE inbox_events SET status = 'QUEUED', attempt_count = 0,
    next_attempt_at = UTC_TIMESTAMP(6), last_error = NULL, processed_at = NULL,
    manual_retry_count = manual_retry_count + 1, last_manual_retry_at = UTC_TIMESTAMP(6)
    WHERE id = ?`, [id(eventId)]);
}

export async function auditRetry({ event, context, reason, connection }) {
  await connection.execute(`INSERT INTO audit_logs
    (id, tenant_id, actor_user_id, actor_type, action, entity_type, entity_id,
     request_id, ip_address, user_agent, before_data, after_data, metadata)
    VALUES (?, ?, ?, 'USER', 'platform.notification.retry_queued', 'NOTIFICATION_EVENT', ?, ?, INET6_ATON(?), ?, ?, ?, ?)`,
  [id(createId()), event.tenant_id, id(context.actor.userId), event.id, context.requestId || null,
    context.ipAddress || null, context.userAgent || null,
    JSON.stringify({ status: event.status, attempts: Number(event.attempt_count), manualRetries: Number(event.manual_retry_count) }),
    JSON.stringify({ status: "QUEUED", attempts: 0, manualRetries: Number(event.manual_retry_count) + 1 }),
    JSON.stringify({ reason, recipientOffsetPreserved: Number(event.recipient_offset) })]);
}

function auditObject(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function auditCounters(value) {
  const source = auditObject(value);
  const count = (input) => Number.isSafeInteger(input) && input >= 0 ? input : null;
  return {
    status: ["FAILED", "QUEUED", "PROCESSED"].includes(source.status) ? source.status : null,
    attempts: count(source.attempts), manualRetries: count(source.manualRetries)
  };
}

// Deliberately project only manual-retry audit fields; never return raw audit JSON.
export async function retryHistory({ eventId, page: requestedPage, pageSize, connection = getPrimaryPool() }) {
  const [[event]] = await connection.execute(
    "SELECT id, tenant_id, status, manual_retry_count FROM inbox_events WHERE id = ?", [id(eventId)]);
  if (!event) return null;
  const where = `a.tenant_id = ? AND a.entity_type = 'NOTIFICATION_EVENT' AND a.entity_id = ?
    AND a.action = 'platform.notification.retry_queued'`;
  const values = [event.tenant_id, event.id];
  const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM audit_logs a WHERE ${where}`, values);
  const total = Number(count.total), totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const [rows] = await connection.execute(`SELECT a.id, a.occurred_at, a.request_id,
    a.before_data, a.after_data, a.metadata, u.first_name, u.last_name
    FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id AND u.deleted_at IS NULL
    WHERE ${where} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ? OFFSET ?`,
  [...values, pageSize, (page - 1) * pageSize]);
  return {
    event: { id: uuid(event.id), status: event.status, manualRetries: Number(event.manual_retry_count) },
    items: rows.map((row) => {
      const metadata = auditObject(row.metadata);
      return {
        id: uuid(row.id), occurredAt: iso(row.occurred_at),
        actorName: [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || "Unavailable user",
        requestId: typeof row.request_id === "string" ? row.request_id.slice(0, 100) : null,
        reason: typeof metadata.reason === "string" ? metadata.reason.trim().slice(0, 500) : null,
        before: auditCounters(row.before_data), after: auditCounters(row.after_data)
      };
    }),
    page, pageSize, total, totalPages
  };
}
