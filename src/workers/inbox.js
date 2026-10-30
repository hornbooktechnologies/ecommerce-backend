import "dotenv/config";
import { setTimeout as pause } from "node:timers/promises";
import { logger } from "../config/logger.js";
import { closePrimaryPool } from "../database/pool-factory.js";
import { createInboxWorker } from "../modules/notifications/inbox.service.js";
import { summary } from "../modules/notifications/inbox.dao.js";
import { createWorkerHeartbeat, getWorkerHealth } from "../modules/notifications/worker-health.service.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
let heartbeat;
try {
  if (process.argv.includes("--status")) {
    logger.info({ queue: await summary(), health: await getWorkerHealth() }, "In-app notification queue and worker health");
  } else {
    const worker = createInboxWorker(), once = process.argv.includes("--once");
    heartbeat = createWorkerHeartbeat({ mode: once ? "ONCE" : "DAEMON", warn: (message) => logger.warn(message) });
    await heartbeat.start();
    logger.info("In-app notification worker started; this worker does not send email.");
    do {
      let result, outcome;
      try {
        result = await worker.once();
        const failed = result && (result.status === "FAILED" || (result.status === "QUEUED" && result.delivered === 0));
        outcome = failed ? "FAILED" : result ? "DELIVERED" : "IDLE";
        if (result) logger.info(result, "In-app notification batch processed");
        if (failed && once) process.exitCode = 1;
      } catch {
        outcome = "FAILED";
        logger.error("In-app notification processing failed. Check database availability and queue status.");
        if (once) process.exitCode = 1;
      }
      // Only report after the delivery transaction has finished; no timer can mask a stuck cycle.
      await heartbeat.cycle(outcome, once);
      if (!once && !controller.signal.aborted) await pause(result ? 250 : 5000, undefined, { signal: controller.signal }).catch(() => {});
    } while (!once && !controller.signal.aborted);
  }
} catch {
  logger.error("In-app notification monitoring unavailable. Check database access and migrations 034–037.");
  process.exitCode = 1;
} finally {
  try { if (heartbeat) await heartbeat.stop(); }
  finally { await closePrimaryPool(); }
}
