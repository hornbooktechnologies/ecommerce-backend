import { createId } from "../../core/identifiers/uuid.js";
import * as defaultDao from "./worker-health.dao.js";

export const HEALTH_THRESHOLDS = Object.freeze({ staleSeconds: 120, stalledSeconds: 300 });
const iso = (value) => value instanceof Date ? value.toISOString() : value || null;
const number = (value) => Number(value || 0);

// Best-effort telemetry must never replay or roll back a committed delivery.
// No independent timer: a stuck worker cannot keep reporting successful cycles.
export function createWorkerHeartbeat({ mode, dao = defaultDao, warn = () => {}, now = () => performance.now() } = {}) {
  if (!["DAEMON", "ONCE"].includes(mode)) throw new Error("Invalid worker mode");
  const runId = createId();
  let lastWrite = -Infinity, lastOutcome = null, failedTelemetry = false;
  async function cycle(outcome, force = false) {
    const time = now();
    if (!force && time - lastWrite < 15000 && (failedTelemetry || outcome === lastOutcome)) return;
    lastWrite = time;
    try {
      await dao.recordCycle({ runId, mode, outcome });
      lastOutcome = outcome; failedTelemetry = false;
    } catch {
      if (!failedTelemetry) warn("Worker heartbeat unavailable. Check database access and migration 037; delivery processing will continue.");
      failedTelemetry = true;
    }
  }
  return {
    start: () => cycle("STARTING", true),
    cycle,
    async stop() {
      try { await dao.recordStop({ runId }); }
      catch { warn("Worker stop could not be recorded. Its heartbeat will become stale automatically."); }
    }
  };
}

export async function getWorkerHealth({ dao = defaultDao } = {}) {
  const raw = await dao.snapshot(HEALTH_THRESHOLDS);
  const w = raw.workers, q = raw.queue;
  const workers = {
    responsive: number(w.responsive_runs), healthy: number(w.healthy_runs), failing: number(w.failing_runs),
    starting: number(w.starting_runs), stale: number(w.stale_runs),
    lastHeartbeatAt: iso(w.last_heartbeat_at), lastSuccessAt: iso(w.last_success_at), lastFailureAt: iso(w.last_failure_at)
  };
  const queue = { due: number(q.due), scheduled: number(q.scheduled), failed: number(q.failed),
    stalled: number(q.stalled), oldestDueIdleSeconds: number(q.oldest_due_idle_seconds) };
  const workerStatus = workers.healthy ? (workers.failing ? "DEGRADED" : "RESPONDING")
    : workers.failing ? "DEGRADED" : workers.starting ? "STARTING" : number(w.known_runs) ? "NO_HEARTBEAT" : "UNOBSERVED";
  const alerts = [];
  if (["NO_HEARTBEAT", "UNOBSERVED"].includes(workerStatus)) alerts.push({ code: "WORKER_UNAVAILABLE", tone: "warning",
    title: workerStatus === "UNOBSERVED" ? "No continuous worker has reported" : "No recent continuous-worker cycle",
    message: "Check the inbox worker process and database access. Start or restart the updated worker using npm run notifications:inbox. One-off runs do not establish continuous health." });
  if (workers.failing) alerts.push({ code: "WORKER_ERRORS", tone: "danger", title: "Worker reported a failed cycle",
    message: "Inspect backend logs and failed deliveries before retrying. A heartbeat alone does not confirm successful delivery." });
  if (queue.stalled) alerts.push({ code: "QUEUE_STALLED", tone: "danger", title: `${queue.stalled} due event(s) may be stalled`,
    message: "These events have had no recorded delivery progress for at least five minutes after becoming due. Check worker availability, database locks and processing capacity. Do not replay orders or payments." });
  if (queue.failed) alerts.push({ code: "FAILED_DELIVERIES", tone: "warning", title: `${queue.failed} delivery event(s) failed`,
    message: "Use the Failed filter below to investigate. Retry only after correcting the underlying problem." });
  return { checkedAt: iso(raw.checkedAt), thresholds: HEALTH_THRESHOLDS, workerStatus, workers, queue, alerts };
}
