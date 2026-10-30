import "dotenv/config";
import { setTimeout as pause } from "node:timers/promises";
import { logger } from "../config/logger.js";
import { closePrimaryPool } from "../database/pool-factory.js";
import { createStockAlertMonitor } from "../modules/notifications/stock-alerts.service.js";
import { summary } from "../modules/notifications/stock-alerts.dao.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  if (process.argv.includes("--status")) logger.info(await summary(), "Stock alert episode state (not current stock totals)");
  else {
    const monitor = createStockAlertMonitor(), once = process.argv.includes("--once");
    logger.info("Stock alert monitor started. First pass includes existing low balances; no stock is changed.");
    do {
      let delay = 30000;
      try {
        const result = await monitor.once({ signal: controller.signal });
        delay = result.cycleComplete ? 30000 : 1000;
        logger.info(result, "Stock alert scan batch");
        if (result.failed) {
          logger.warn("Some balances could not be checked; they will be retried on the next scan cycle.");
          if (once) process.exitCode = 1;
        }
      } catch {
        logger.error("Stock alert scan failed. Check database access and migration 035 before retrying.");
        if (once) process.exitCode = 1;
      }
      if (!once && !controller.signal.aborted) await pause(delay, undefined, { signal: controller.signal }).catch(() => {});
    } while (!once && !controller.signal.aborted);
  }
} catch {
  logger.error("Stock alert monitor unavailable. Check database access and migration 035.");
  process.exitCode = 1;
} finally { await closePrimaryPool(); }
