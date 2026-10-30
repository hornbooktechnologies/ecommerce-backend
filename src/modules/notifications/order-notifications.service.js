import { validate as isUuid } from "uuid";
import * as defaultDao from "./order-notifications.dao.js";
import { createOrderMailer } from "./order-notifications.mail.js";
import { messages } from "./order-notifications.events.js";

const safeCodes = new Set(["EAUTH", "ECONNECTION", "ECONNREFUSED", "ETIMEDOUT", "ESOCKET", "EDNS", "EENVELOPE", "EMESSAGE", "CUSTOMER_EMAIL_UNAVAILABLE"]);
function valid(job) {
  const payload = job.payload;
  return payload && Object.hasOwn(messages, payload.kind) && isUuid(payload.orderId || "")
    && isUuid(payload.customerId || "") && (!payload.returnId || isUuid(payload.returnId))
    && (!(payload.kind.startsWith("RETURN_") || payload.kind.startsWith("EXCHANGE_")) || payload.returnId);
}

export function createOrderNotificationWorker({ dao = defaultDao, mailer = createOrderMailer() } = {}) {
  return {
    async once(workerId) {
      const job = await dao.claim(workerId);
      if (!job) return null;
      if (!valid(job)) {
        await dao.finish(job, { status: "FAILED", error: "INVALID_NOTIFICATION" });
        return { id: job.id, status: "FAILED" };
      }
      let status;
      try {
        const recipient = await dao.recipient(job);
        if (!recipient) status = "SKIPPED";
        else {
          await mailer.send(job, recipient);
          status = "SUCCEEDED"; // SMTP acceptance, not proof of inbox delivery.
        }
      } catch (error) {
        status = job.attempt < job.maxAttempts ? "QUEUED" : "FAILED";
        const code = safeCodes.has(error.code) ? error.code : "NOTIFICATION_DELIVERY_FAILED";
        // Never persist SMTP response text, recipients, credentials, or order content in errors.
        const acknowledged = await dao.finish(job, { status, error: code, delay: Math.min(3600, 60 * 2 ** (job.attempt - 1)) });
        return { id: job.id, status: acknowledged ? status : "LEASE_LOST" };
      }
      // A DB failure after SMTP acceptance must not be misclassified as a send failure.
      const acknowledged = await dao.finish(job, { status });
      return { id: job.id, status: acknowledged ? status : "LEASE_LOST" };
    }
  };
}
