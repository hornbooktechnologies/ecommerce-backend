import {createReminderMonitor} from '../modules/reminders/reminders.service.js';
import {createShoppingMonitor} from '../modules/shopping/shopping.service.js';
import {pruneHistory} from '../modules/shopping/shopping.dao.js';
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
    const reminders=createReminderMonitor();let nextReminderScan=0;
    const shopping=createShoppingMonitor(); let nextShoppingScan=0;
    const worker = createInboxWorker(), once = process.argv.includes("--once");
    heartbeat = createWorkerHeartbeat({ mode: once ? "ONCE" : "DAEMON", warn: (message) => logger.warn(message) });
    await heartbeat.start();
    logger.info("In-app notification worker started; this worker does not send email.");
    do {
      if(Date.now()>=nextShoppingScan){try{const expiredHistoryRemoved=await pruneHistory();const scan=await shopping.once();nextShoppingScan=Date.now()+(scan.cycleComplete?30000:1000);if(scan.scanned||expiredHistoryRemoved)logger.info({...scan,expiredHistoryRemoved},'Shopping alert scan');if(once&&scan.failed)process.exitCode=1;}catch{nextShoppingScan=Date.now()+30000;logger.warn('Shopping alert scan unavailable; essential inbox delivery will continue. Check migration 047.');if(once)process.exitCode=1;}}
      if(Date.now()>=nextReminderScan){try{const scan=await reminders.once();nextReminderScan=Date.now()+(scan.cycleComplete?60000:1000);if(scan.scanned)logger.info(scan,'Shopping reminder scan');if(once&&scan.failed)process.exitCode=1;}catch{nextReminderScan=Date.now()+60000;logger.warn('Reminder scan unavailable; essential inbox delivery continues. Check migration 053.');if(once)process.exitCode=1;}}
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
