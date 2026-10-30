import { getPrimaryPool } from "../../database/pool-factory.js";
import { createId, uuidToBuffer as id, bufferToUuid as uuid } from "../../core/identifiers/uuid.js";
import { paymentError } from "./razorpay.js";

export async function webhookAccount(accountId, connection = getPrimaryPool()) {
  const [rows] = await connection.execute(`SELECT a.tenant_id, a.key_id, s.secret_encrypted
    FROM tenant_payment_accounts a JOIN payment_webhook_secrets s ON s.account_id = a.id
    WHERE a.id = ? AND (s.expires_at IS NULL OR s.expires_at > UTC_TIMESTAMP(6))`, [id(accountId)]);
  return rows.length ? { tenantId: uuid(rows[0].tenant_id), keyId: rows[0].key_id, secrets: rows.map((row) => row.secret_encrypted) } : null;
}

export async function acceptEvent(event, connection = getPrimaryPool()) {
  // Only identifiers and a body hash are retained, never card/contact details or raw payloads.
  await connection.execute(`INSERT INTO payment_webhook_events
    (id, tenant_id, account_id, event_id, body_hash, event_type, gateway_order_id, gateway_payment_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`,
  [id(createId()), id(event.tenantId), id(event.accountId), event.eventId, event.bodyHash, event.type, event.orderId, event.paymentId]);
  const [[stored]] = await connection.execute("SELECT body_hash FROM payment_webhook_events WHERE account_id = ? AND event_id = ?", [id(event.accountId), event.eventId]);
  if (stored.body_hash !== event.bodyHash) paymentError("WEBHOOK_EVENT_CONFLICT", "Event identifier does not match its original payload.", 409);
}

export async function transaction(operation, pool = getPrimaryPool()) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

const scope = (row) => row ? { attemptId: uuid(row.id), tenantId: uuid(row.tenant_id), storeId: uuid(row.store_id),
  customerId: uuid(row.customer_id), orderId: uuid(row.order_id), failures: row.reconcile_failures,
  age: Number(row.age_seconds || 0) } : null;

export async function nextEvent(connection) {
  const [[row]] = await connection.execute(`SELECT *, TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP(6)) AS age_seconds
    FROM payment_webhook_events WHERE status = 'PENDING' AND next_attempt_at <= UTC_TIMESTAMP(6)
    ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE`);
  return row ? { id: uuid(row.id), tenantId: uuid(row.tenant_id), accountId: uuid(row.account_id),
    orderId: row.gateway_order_id, count: row.attempt_count, age: Number(row.age_seconds), type: row.event_type } : null;
}

export async function eventAttempt(event, connection) {
  const [[row]] = await connection.execute(`SELECT *, TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP(6)) AS age_seconds
    FROM storefront_payment_attempts WHERE tenant_id = ? AND account_id = ? AND gateway_order_id = ? FOR UPDATE`,
  [id(event.tenantId), id(event.accountId), event.orderId]);
  return scope(row);
}

export async function nextAttempt(connection) {
  const [[row]] = await connection.execute(`SELECT *, TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP(6)) AS age_seconds
    FROM storefront_payment_attempts WHERE captured_payment_id IS NULL AND gateway_order_id IS NOT NULL
      AND next_reconcile_at <= UTC_TIMESTAMP(6) ORDER BY next_reconcile_at, id LIMIT 1 FOR UPDATE`);
  return scope(row);
}

export async function eventResult(event, { status, code = null, delay = 0 }, connection) {
  await connection.execute(`UPDATE payment_webhook_events SET status = ?, attempt_count = attempt_count + 1,
    last_error = ?, next_attempt_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND),
    processed_at = IF(? = 'PENDING', NULL, UTC_TIMESTAMP(6)) WHERE id = ? AND tenant_id = ?`,
  [status, code, delay, status, id(event.id), id(event.tenantId)]);
}

export async function attemptResult(attempt, { code = null, delay }, connection) {
  await connection.execute(`UPDATE storefront_payment_attempts SET last_reconciled_at = UTC_TIMESTAMP(6),
    reconcile_failures = IF(? IS NULL, 0, reconcile_failures + 1), last_reconcile_error = ?,
    next_reconcile_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND) WHERE id = ? AND tenant_id = ?`,
  [code, code, delay, id(attempt.attemptId), id(attempt.tenantId)]);
}

export async function summary(connection = getPrimaryPool()) {
  const [events] = await connection.execute("SELECT status, COUNT(*) AS count FROM payment_webhook_events GROUP BY status");
  const [[attempts]] = await connection.execute(`SELECT COUNT(*) AS pending,
    COALESCE(SUM(last_reconcile_error IS NOT NULL), 0) AS needingAttention FROM storefront_payment_attempts
    WHERE captured_payment_id IS NULL AND gateway_order_id IS NOT NULL`);
  return { events, attempts };
}
