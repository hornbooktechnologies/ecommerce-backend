import "dotenv/config";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { logger } from "../config/logger.js";
import { closePrimaryPool } from "../database/pool-factory.js";
import { enabled } from "../modules/notifications/order-notifications.events.js";
import { summary } from "../modules/notifications/order-notifications.dao.js";
import { createOrderNotificationWorker } from "../modules/notifications/order-notifications.service.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  if (process.argv.includes("--status")) logger.info({ queue: await summary() }, "Order email queue status");
  else if (!enabled()) logger.info("Order email delivery is disabled. Configure SMTP and ORDER_EMAILS_ENABLED=true in API and worker environments to enable new notifications.");
  else {
    const worker = createOrderNotificationWorker();
    const workerId = `${hostname().slice(0, 60)}:${process.pid}:${randomUUID()}`;
    const once = process.argv.includes("--once");
    logger.info("Order email worker started; queued messages will be sent through SMTP.");
    do {
      try {
        const result = await worker.once(workerId);
        if (result) logger.info(result, "Order email job processed");
        if (!once && !controller.signal.aborted) await pause(result ? 250 : 5000, undefined, { signal: controller.signal });
      } catch {
        if (!controller.signal.aborted) {
          logger.error("Order email worker could not process a job. Check database availability and queue status.");
          if (once) process.exitCode = 1;
          else await pause(5000, undefined, { signal: controller.signal }).catch(() => {});
        }
      }
    } while (!once && !controller.signal.aborted);
  }
} finally { await closePrimaryPool(); }
