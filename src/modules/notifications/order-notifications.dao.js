import { getPrimaryPool } from "../../database/pool-factory.js";
import { createId, uuidToBuffer as id, bufferToUuid as uuid } from "../../core/identifiers/uuid.js";
import { enabled, messages, orderNotification, queueName } from "./order-notifications.events.js";
import { enqueueOrderInbox, enqueueReturnInbox } from "./inbox.events.js";

const recipientQuery = `SELECT o.customer_id, o.order_number, a.email,
  t.code AS tenant_code, t.display_name AS tenant_name, s.code AS store_code, s.name AS store_name
  FROM customer_orders o
  JOIN tenants t ON t.id = o.tenant_id AND t.status = 'ACTIVE' AND t.deleted_at IS NULL
  JOIN stores s ON s.id = o.store_id AND s.tenant_id = o.tenant_id AND s.status = 'ACTIVE' AND s.deleted_at IS NULL
  JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id AND c.status = 'ACTIVE' AND c.deleted_at IS NULL
  JOIN customer_accounts a ON a.customer_id = c.id AND a.tenant_id = c.tenant_id AND a.verified_at IS NOT NULL
  WHERE o.tenant_id = ? AND o.id = ?`;

async function enqueue({ tenantId, orderId, returnId = null, kind, key, connection }) {
  if (!enabled() || !Object.hasOwn(messages, kind)) return;
  const [[row]] = await connection.execute(recipientQuery, [id(tenantId), id(orderId)]);
  if (!row) return; // No mail to guest/snapshot addresses or to accounts created after the event.
  await connection.execute(`INSERT INTO background_jobs
    (id, tenant_id, queue_name, job_type, payload, deduplication_key)
    VALUES (?, ?, ?, 'ORDER_NOTIFICATION', ?, ?)
    ON DUPLICATE KEY UPDATE id = id`, [id(createId()), id(tenantId), queueName,
    JSON.stringify({ kind, orderId, customerId: uuid(row.customer_id), returnId }), `${kind}:${key}`]);
}

export async function enqueueOrderEvent({ event, connection }) {
  await enqueueOrderInbox({ event, connection });
  if (!enabled()) return;
  const notification = orderNotification(event);
  if (notification) await enqueue({ tenantId: event.tenantId, orderId: event.orderId, ...notification, connection });
}

export async function enqueueReturnEvent({ tenantId, returnId, kind, key = returnId, connection }) {
  await enqueueReturnInbox({ tenantId, returnId, kind, key, connection });
  if (!enabled()) return;
  const [[row]] = await connection.execute("SELECT customer_order_id FROM return_requests WHERE tenant_id = ? AND id = ?", [id(tenantId), id(returnId)]);
  if (row) await enqueue({ tenantId, orderId: uuid(row.customer_order_id), returnId, kind, key, connection });
}

export async function recipient(job, connection = getPrimaryPool()) {
  const [[row]] = await connection.execute(`${recipientQuery} AND o.customer_id = ?`,
    [id(job.tenantId), id(job.payload.orderId), id(job.payload.customerId)]);
  if (!row) return null;
  let returnNumber = null;
  if (job.payload.returnId) {
    const [[request]] = await connection.execute(`SELECT return_number FROM return_requests
      WHERE tenant_id = ? AND id = ? AND customer_order_id = ?`,
    [id(job.tenantId), id(job.payload.returnId), id(job.payload.orderId)]);
    if (!request) return null;
    returnNumber = request.return_number;
  }
  return { email: row.email, orderNumber: row.order_number, returnNumber,
    tenantCode: row.tenant_code, tenantName: row.tenant_name, storeCode: row.store_code, storeName: row.store_name };
}

async function inTransaction(pool, operation) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

// Atomic ordered UPDATE is supported by MariaDB 10.4; no SKIP LOCKED required.
export async function claim(workerId, pool = getPrimaryPool()) {
  return inTransaction(pool, async (connection) => {
    await connection.execute(`UPDATE background_job_attempts a JOIN background_jobs j ON j.id = a.job_id
      SET a.status = 'FAILED', a.completed_at = UTC_TIMESTAMP(6), a.error_message = 'LEASE_EXPIRED'
      WHERE j.queue_name = ? AND j.status = 'RUNNING' AND j.lock_expires_at <= UTC_TIMESTAMP(6)
      AND j.attempt_count >= j.max_attempts AND a.status = 'RUNNING'`, [queueName]);
    await connection.execute(`UPDATE background_jobs SET status = 'FAILED', last_error = 'LEASE_EXPIRED',
      completed_at = UTC_TIMESTAMP(6), claim_token = NULL, locked_by = NULL, locked_at = NULL, lock_expires_at = NULL
      WHERE queue_name = ? AND status = 'RUNNING' AND lock_expires_at <= UTC_TIMESTAMP(6)
      AND attempt_count >= max_attempts`, [queueName]);
    const token = createId();
    const [result] = await connection.execute(`UPDATE background_jobs SET status = 'RUNNING',
      claim_token = ?, locked_by = ?, locked_at = UTC_TIMESTAMP(6),
      lock_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 2 MINUTE), attempt_count = attempt_count + 1
      WHERE queue_name = ? AND attempt_count < max_attempts AND
      ((status = 'QUEUED' AND run_at <= UTC_TIMESTAMP(6)) OR (status = 'RUNNING' AND lock_expires_at <= UTC_TIMESTAMP(6)))
      ORDER BY priority DESC, created_at, id LIMIT 1`, [id(token), workerId, queueName]);
    if (!result.affectedRows) return null;
    const [[row]] = await connection.execute("SELECT * FROM background_jobs WHERE claim_token = ?", [id(token)]);
    await connection.execute(`UPDATE background_job_attempts SET status = 'FAILED', completed_at = UTC_TIMESTAMP(6),
      error_message = 'LEASE_EXPIRED' WHERE job_id = ? AND status = 'RUNNING'`, [row.id]);
    await connection.execute(`INSERT INTO background_job_attempts (id, job_id, attempt_number, worker_id)
      VALUES (?, ?, ?, ?)`, [id(createId()), row.id, row.attempt_count, workerId]);
    return { id: uuid(row.id), tenantId: uuid(row.tenant_id), token, attempt: row.attempt_count,
      maxAttempts: row.max_attempts, payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload };
  });
}

export async function finish(job, { status, error = null, delay = 0 }, pool = getPrimaryPool()) {
  return inTransaction(pool, async (connection) => {
    const [result] = await connection.execute(`UPDATE background_jobs SET status = ?, last_error = ?,
      run_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND),
      completed_at = IF(? = 'QUEUED', NULL, UTC_TIMESTAMP(6)),
      claim_token = NULL, locked_by = NULL, locked_at = NULL, lock_expires_at = NULL
      WHERE id = ? AND tenant_id = ? AND queue_name = ? AND status = 'RUNNING' AND claim_token = ?`,
    [status, error, delay, status, id(job.id), id(job.tenantId), queueName, id(job.token)]);
    if (result.affectedRows) await connection.execute(`UPDATE background_job_attempts
      SET status = ?, completed_at = UTC_TIMESTAMP(6), error_message = ? WHERE job_id = ? AND attempt_number = ?`,
    [status === "QUEUED" ? "FAILED" : status, error, id(job.id), job.attempt]);
    return Boolean(result.affectedRows);
  });
}

export async function summary(connection = getPrimaryPool()) {
  const [rows] = await connection.execute(`SELECT status, COUNT(*) AS count FROM background_jobs WHERE queue_name = ? GROUP BY status`, [queueName]);
  return rows;
}
