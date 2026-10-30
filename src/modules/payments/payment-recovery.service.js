import { AppError } from "../../core/errors/app-error.js";
import * as defaultDao from "./payment-recovery.dao.js";
import { createPaymentsService } from "./payments.service.js";

const codes = new Set(["PAYMENT_PROVIDER_UNAVAILABLE", "PAYMENT_ACCOUNT_UNAVAILABLE", "PAYMENT_ENCRYPTION_NOT_CONFIGURED",
  "PAYMENT_MISMATCH", "PAYMENT_REFUNDED", "PAYMENT_CAPTURE_CONFLICT", "PAYMENT_NOT_FOUND", "TEST_KEYS_REQUIRED", "PAYMENT_AMOUNT_INVALID"]);
const transient = new Set(["PAYMENT_PROVIDER_UNAVAILABLE", "PAYMENT_ACCOUNT_UNAVAILABLE", "PAYMENT_ENCRYPTION_NOT_CONFIGURED"]);
export const recoveryEnabled = () => process.env.PAYMENT_RECOVERY_ENABLED === "true";

export function createPaymentRecovery({ dao = defaultDao, payments = createPaymentsService() } = {}) {
  let preferEvents = true;
  async function recover(attempt, connection) {
    await connection.query("SAVEPOINT payment_recovery");
    try {
      const receipt = await payments.read({ ...attempt, connection }, { id: attempt.orderId, paymentMethod: "ONLINE_TEST" }, { refresh: true });
      return { paid: receipt.paymentStatus === "PAID", code: null };
    } catch (error) {
      // Never commit a partially written ledger. SQL errors abort the whole transaction.
      if (!(error instanceof AppError)) throw error;
      await connection.query("ROLLBACK TO SAVEPOINT payment_recovery");
      return { paid: false, code: codes.has(error.code) ? error.code : "PAYMENT_RECOVERY_REVIEW" };
    }
  }
  return {
    async once() {
      const tryEvents = preferEvents; preferEvents = !preferEvents;
      return dao.transaction(async (connection) => {
        let event = tryEvents ? await dao.nextEvent(connection) : null;
        let attempt = event ? await dao.eventAttempt(event, connection) : await dao.nextAttempt(connection);
        if (!event && !attempt && !tryEvents) {
          event = await dao.nextEvent(connection);
          if (event) attempt = await dao.eventAttempt(event, connection);
        }
        if (!event && !attempt) return null;
        if (!attempt) {
          // A webhook can beat the checkout commit. Retry matching before discarding unrelated orders.
          const status = event.age >= 86400 ? "IGNORED" : "PENDING";
          await dao.eventResult(event, { status, code: "ORDER_NOT_LINKED", delay: 300 }, connection);
          return { eventId: event.id, status };
        }
        const result = await recover(attempt, connection);
        const retryDelay = Math.min(3600, 60 * 2 ** Math.min(attempt.failures || 0, 6));
        const delay = result.code ? retryDelay : attempt.age < 86400 ? 300 : 86400;
        await dao.attemptResult(attempt, { code: result.code, delay }, connection);
        let status = result.code ? "REVIEW" : "PROCESSED";
        if (event) {
          if (result.code && transient.has(result.code) && event.count < 19) status = "PENDING";
          // A capture notification can precede the API's captured representation; do not lose it.
          if (!result.code && !result.paid && ["payment.captured", "order.paid"].includes(event.type)) {
            status = event.count < 19 ? "PENDING" : "REVIEW";
          }
          await dao.eventResult(event, { status, code: result.code, delay: retryDelay }, connection);
        }
        return { attemptId: attempt.attemptId, ...(event ? { eventId: event.id } : {}),
          status, paymentStatus: result.paid ? "PAID" : "UNPAID" };
      });
    }
  };
}
