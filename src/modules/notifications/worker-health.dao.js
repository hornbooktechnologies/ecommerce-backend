import { getPrimaryPool } from "../../database/pool-factory.js";
import { uuidToBuffer } from "../../core/identifiers/uuid.js";

export async function recordCycle({ runId, mode, outcome, connection = getPrimaryPool() }) {
  const completed = outcome !== "STARTING", succeeded = ["IDLE", "DELIVERED"].includes(outcome);
  await connection.execute({ sql: `INSERT INTO inbox_worker_runs
    (id, run_mode, outcome, last_cycle_at, last_success_at, last_failure_at)
    VALUES (?, ?, ?, IF(?, UTC_TIMESTAMP(6), NULL), IF(?, UTC_TIMESTAMP(6), NULL), IF(?, UTC_TIMESTAMP(6), NULL))
    ON DUPLICATE KEY UPDATE state = 'RUNNING', stopped_at = NULL, outcome = VALUES(outcome),
      heartbeat_at = UTC_TIMESTAMP(6), last_cycle_at = COALESCE(VALUES(last_cycle_at), last_cycle_at),
      last_success_at = COALESCE(VALUES(last_success_at), last_success_at),
      last_failure_at = COALESCE(VALUES(last_failure_at), last_failure_at)`, timeout: 5000 },
  [uuidToBuffer(runId), mode, outcome, completed, succeeded, outcome === "FAILED"]);
}

export async function recordStop({ runId, connection = getPrimaryPool() }) {
  await connection.execute({ sql: `UPDATE inbox_worker_runs SET state = 'STOPPED',
    stopped_at = UTC_TIMESTAMP(6), heartbeat_at = UTC_TIMESTAMP(6) WHERE id = ?`, timeout: 5000 }, [uuidToBuffer(runId)]);
}

// Compute ages using the database clock; don't compare clocks across processes.
export async function snapshot({ staleSeconds, stalledSeconds, connection = getPrimaryPool() }) {
  const [[workers]] = await connection.execute(`SELECT
    COUNT(*) AS known_runs,
    SUM(state = 'RUNNING' AND last_cycle_at >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? SECOND)) AS responsive_runs,
    SUM(state = 'RUNNING' AND outcome IN ('IDLE', 'DELIVERED')
      AND last_cycle_at >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? SECOND)) AS healthy_runs,
    SUM(state = 'RUNNING' AND outcome = 'FAILED'
      AND last_cycle_at >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? SECOND)) AS failing_runs,
    SUM(state = 'RUNNING' AND last_cycle_at IS NULL
      AND heartbeat_at >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? SECOND)) AS starting_runs,
    SUM(state = 'RUNNING' AND heartbeat_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? SECOND)) AS stale_runs,
    MAX(heartbeat_at) AS last_heartbeat_at, MAX(last_success_at) AS last_success_at,
    MAX(last_failure_at) AS last_failure_at
    FROM inbox_worker_runs WHERE run_mode = 'DAEMON'`, Array(5).fill(staleSeconds));
  const [[queue]] = await connection.execute(`SELECT
    SUM(status = 'QUEUED' AND next_attempt_at <= UTC_TIMESTAMP(6)) AS due,
    SUM(status = 'QUEUED' AND next_attempt_at > UTC_TIMESTAMP(6)) AS scheduled,
    SUM(status = 'FAILED') AS failed,
    SUM(status = 'QUEUED' AND GREATEST(next_attempt_at, COALESCE(last_delivery_progress_at, next_attempt_at))
      <= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? SECOND)) AS stalled,
    MAX(CASE WHEN status = 'QUEUED' AND next_attempt_at <= UTC_TIMESTAMP(6)
      THEN GREATEST(0, TIMESTAMPDIFF(SECOND,
        GREATEST(next_attempt_at, COALESCE(last_delivery_progress_at, next_attempt_at)), UTC_TIMESTAMP(6))) END) AS oldest_due_idle_seconds
    FROM inbox_events WHERE status IN ('QUEUED', 'FAILED')`, [stalledSeconds]);
  const [[clock]] = await connection.execute("SELECT UTC_TIMESTAMP(6) AS checked_at");
  return { workers, queue, checkedAt: clock.checked_at };
}
