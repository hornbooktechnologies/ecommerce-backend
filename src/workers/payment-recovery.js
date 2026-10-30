import "dotenv/config";
import { setTimeout as pause } from "node:timers/promises";
import { logger } from "../config/logger.js";
import { closePrimaryPool } from "../database/pool-factory.js";
import { createPaymentRecovery, recoveryEnabled } from "../modules/payments/payment-recovery.service.js";
import { summary } from "../modules/payments/payment-recovery.dao.js";

const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
try {
  if (process.argv.includes("--status")) logger.info(await summary(), "Payment recovery status");
  else if (!recoveryEnabled()) logger.info("Payment recovery is disabled. Set PAYMENT_RECOVERY_ENABLED=true and run this worker separately from the API.");
  else {
    const worker = createPaymentRecovery(), once = process.argv.includes("--once");
    logger.info("Payment recovery worker started (TEST accounts only; no capture/refund requests).");
    do {
      try {
        const result = await worker.once();
        if (result) logger.info(result, "Payment recovery checked");
        if (!once && !abort.signal.aborted) await pause(result ? 250 : 5000, undefined, { signal: abort.signal });
      } catch {
        if (!abort.signal.aborted) {
          logger.error("Payment recovery transaction failed. Check database availability; no provider secrets are logged.");
          if (once) process.exitCode = 1;
          else await pause(5000, undefined, { signal: abort.signal }).catch(() => {});
        }
      }
    } while (!once && !abort.signal.aborted);
  }
} finally { await closePrimaryPool(); }
