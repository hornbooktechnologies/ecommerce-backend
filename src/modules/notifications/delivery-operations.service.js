import { validate as validUuid } from "uuid";
import { AppError } from "../../core/errors/app-error.js";
import { withTransaction } from "../../database/transaction.js";
import { activeSession } from "./inbox.dao.js";
import { findPlatformAccess } from "../platform-access/platform-access.dao.js";
import * as defaultDao from "./delivery-operations.dao.js";
import { getWorkerHealth } from "./worker-health.service.js";

export const MAX_MANUAL_RETRIES = 3;
function fail(code, message, status = 409) { throw new AppError({ code, message, status }); }

export function createDeliveryOperationsService({ dao = defaultDao, transaction = withTransaction,
  session = activeSession, platformAccess = findPlatformAccess, health = getWorkerHealth } = {}) {
  async function authorize(context, { retry = false, audit = false, connection } = {}) {
    const actor = context?.actor;
    if (!actor?.userId || !actor?.sessionId || !await session({ ...actor, connection })) {
      fail("AUTHENTICATION_REQUIRED", "Your session is invalid or has expired.", 401);
    }
    const access = await platformAccess({ userId: actor.userId, connection });
    const required = ["platform.notification.read", ...(retry ? ["platform.notification.retry"] : []),
      ...(audit ? ["platform.audit.read"] : [])];
    if (!access || (!access.unrestricted && !required.every((key) => access.permissions.includes(key)))) {
      fail("FORBIDDEN", "You do not have permission to manage notification deliveries.", 403);
    }
  }
  return {
    async history(context, eventId, pagination) {
      return transaction(null, async (connection) => {
        await authorize(context, { audit: true, connection });
        const result = await dao.retryHistory({ eventId, ...pagination, connection });
        if (!result) fail("NOTIFICATION_NOT_FOUND", "Notification delivery was not found.", 404);
        return result;
      });
    },
    async health(context) {
      await authorize(context);
      return health();
    },
    async list(context, filters) {
      await authorize(context);
      return { ...await dao.list({ filters }), maxManualRetries: MAX_MANUAL_RETRIES };
    },
    async retry(context, eventId, input) {
      return transaction(null, async (connection) => {
        await authorize(context, { retry: true, connection });
        const event = await dao.lock({ eventId, connection });
        if (!event) fail("NOTIFICATION_NOT_FOUND", "Notification delivery was not found.", 404);
        if (event.status !== "FAILED" || Number(event.manual_retry_count) !== input.expectedManualRetries) {
          fail("DELIVERY_CHANGED", "This delivery changed. Refresh the list before retrying.");
        }
        if (Number(event.manual_retry_count) >= MAX_MANUAL_RETRIES) {
          fail("RETRY_LIMIT_REACHED", "This delivery reached its manual retry limit. Investigate the underlying failure.");
        }
        let recipients;
        try { recipients = typeof event.recipients === "string" ? JSON.parse(event.recipients) : event.recipients; } catch { recipients = null; }
        const offset = Number(event.recipient_offset);
        if (!Array.isArray(recipients) || !recipients.length || !recipients.every((value) => typeof value === "string" && validUuid(value))
          || !Number.isInteger(offset) || offset < 0 || offset > recipients.length) {
          fail("DELIVERY_DATA_INVALID", "The delivery snapshot needs repair before it can be retried.");
        }
        await dao.queueRetry({ eventId, connection });
        await dao.auditRetry({ event, context, reason: input.reason, connection });
        return { id: eventId, status: "QUEUED", manualRetries: Number(event.manual_retry_count) + 1 };
      });
    }
  };
}
