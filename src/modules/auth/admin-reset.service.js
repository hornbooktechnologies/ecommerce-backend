import { createHash } from "node:crypto";
import { withTransaction } from "../../database/transaction.js";
import { createId } from "../../core/identifiers/uuid.js";
import { createPasswordResetToken, hashPasswordResetToken } from "../../core/security/tokens.js";
import { logger } from "../../config/logger.js";
import { limit } from "../customer-accounts/customer-accounts.dao.js";
import * as authDao from "./auth.dao.js";
import { createAdminResetMailer } from "./admin-reset.mail.js";

const accepted = { message: "If an active account matches that email, a reset link will be emailed. Check your inbox and spam folder.", expiresInMinutes: 30 };
export function createAdminResetService({ dao = authDao, transaction = withTransaction, mailer = createAdminResetMailer(), limiter = limit, log = logger } = {}) {
  return { async request({ email, ipAddress, userAgent }) {
    // Validate shared delivery configuration for every address, not just known users.
    mailer.ready();
    const bucketHash = createHash("sha256").update(`admin-reset:ip:${ipAddress || "unknown"}`).digest();
    if (!await limiter({ bucketHash, maximum: 30 })) return { ...accepted };
    const delivery = await transaction(null, async (connection) => {
      const user = await dao.findUserByEmail({ email: email.trim().toLowerCase(), connection, forUpdate: true });
      if (!user || user.status !== "ACTIVE") return null;
      if (await dao.countRecentPasswordResetRequests({ userId: user.id, connection }) >= 3) return null;
      const token = createPasswordResetToken(), tokenHash = hashPasswordResetToken(token);
      await dao.invalidatePasswordResetTokens({ userId: user.id, connection });
      await dao.insertPasswordResetToken({ reset: { id: createId(), userId: user.id, tokenHash,
        ipAddress, userAgent: userAgent?.slice(0, 500) || null, expiresAt: new Date(Date.now() + 30 * 60 * 1000) }, connection });
      return { email: user.email, token, tokenHash };
    });
    if (delivery) {
      try { await mailer.send(delivery); }
      catch {
        // Invalidate only this request. Never revoke a newer concurrent email link.
        await dao.invalidatePasswordResetTokenHash({ tokenHash: delivery.tokenHash });
        log.warn({ event: "admin.password_reset.delivery_failed", code: "ADMIN_RESET_EMAIL_FAILED" }, "Admin reset email failed; matching token revoked. No recipient or token is logged.");
      }
    }
    // No account-specific delivery results or development tokens leave this service.
    return { ...accepted };
  } };
}
