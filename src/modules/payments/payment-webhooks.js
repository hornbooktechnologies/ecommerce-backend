import { createHash } from "node:crypto";
import { Router, raw } from "express";
import { validate as isUuid } from "uuid";
import { createCredentialVault, paymentError, verifyWebhookSignature } from "./razorpay.js";
import * as defaultDao from "./payment-recovery.dao.js";

const supported = new Set(["payment.authorized", "payment.captured", "payment.failed", "order.paid"]);
export function createPaymentWebhooks({ dao = defaultDao, vault = createCredentialVault() } = {}) {
  return {
    async receive({ accountId, signature, eventId, body }) {
      if (!isUuid(accountId || "") || !Buffer.isBuffer(body) || !/^[a-f0-9]{64}$/i.test(signature || "")) {
        paymentError("WEBHOOK_SIGNATURE_INVALID", "Webhook could not be verified.", 401);
      }
      const account = await dao.webhookAccount(accountId);
      if (!account || !/^rzp_test_[A-Za-z0-9]+$/.test(account.keyId)
        || !account.secrets.some((encrypted) => verifyWebhookSignature(body, signature, vault.decrypt(encrypted, `${account.tenantId}:webhook`)))) {
        paymentError("WEBHOOK_SIGNATURE_INVALID", "Webhook could not be verified.", 401);
      }
      let payload;
      try { payload = JSON.parse(body.toString("utf8")); }
      catch { paymentError("WEBHOOK_BODY_INVALID", "Webhook body is not valid JSON.", 400); }
      if (!supported.has(payload?.event)) return { received: true, ignored: true };
      if (!/^[A-Za-z0-9_-]{1,190}$/.test(eventId || "")) paymentError("WEBHOOK_EVENT_ID_REQUIRED", "A valid event identifier is required.", 400);
      const payment = payload.payload?.payment?.entity;
      const orderId = payment?.order_id || payload.payload?.order?.entity?.id;
      if (!/^order_[A-Za-z0-9]{1,74}$/.test(orderId || "")) return { received: true, ignored: true }; // Unrelated payment links etc.
      const paymentId = /^pay_[A-Za-z0-9]{1,76}$/.test(payment?.id || "") ? payment.id : null;
      await dao.acceptEvent({ tenantId: account.tenantId, accountId, eventId,
        bodyHash: createHash("sha256").update(body).digest("hex"), type: payload.event, orderId, paymentId });
      return { received: true };
    }
  };
}

export function createPaymentWebhookRouter({ service = createPaymentWebhooks() } = {}) {
  const router = Router();
  router.post("/razorpay/test/:accountId", raw({ type: "application/json", limit: "128kb", inflate: false }), async (req, res) => {
    res.set("Cache-Control", "no-store").json(await service.receive({ accountId: req.params.accountId,
      signature: req.get("x-razorpay-signature"), eventId: req.get("x-razorpay-event-id"), body: req.body }));
  });
  // Avoid generic parser errors logging any raw provider payload or misleading image-upload messages.
  router.use((error, _req, _res, next) => {
    if (error.type === "entity.too.large") {
      try { paymentError("WEBHOOK_TOO_LARGE", "Webhook exceeds 128 KB.", 413); } catch (safeError) { return next(safeError); }
    }
    if (error.type === "encoding.unsupported") {
      try { paymentError("WEBHOOK_ENCODING_INVALID", "Send an uncompressed JSON webhook.", 415); } catch (safeError) { return next(safeError); }
    }
    next(error);
  });
  return router;
}
