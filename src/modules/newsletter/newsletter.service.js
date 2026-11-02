import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import { resolveStore } from "../storefront/storefront.dao.js";
import { limit } from "../customer-accounts/customer-accounts.dao.js";
import * as defaultDao from "./newsletter.dao.js";
import { createNewsletterMailer, emailUnavailable } from "./newsletter.mail.js";
import { CONSENT_VERSION } from "./newsletter.validators.js";

const digest = (value) => createHash("sha256").update(value).digest();
const secret = () => randomBytes(32).toString("hex");
const fail = (code, message, status) => { throw new AppError({ code, message, status }); };
const accepted = { message: "If this address is eligible, a confirmation link has been sent. Check your inbox and spam folder. You must confirm before receiving newsletters." };
export function createNewsletterService({ dao = defaultDao, transaction = withTransaction,
  storeResolver = resolveStore, limiter = limit, mailer = createNewsletterMailer() } = {}) {
  async function scope(params, allowInactive = false) {
    const store = allowInactive ? await dao.resolveUnsubscribeStore(params) : await storeResolver(params);
    if (!store) fail("STORE_NOT_FOUND", "This store is unavailable.", 404);
    return { ...store, ...params };
  }
  async function throttle(store, key, maximum) {
    if (!await limiter({ bucketHash: digest(`newsletter:${store.tenantId}:${store.storeId}:${key}`), maximum })) {
      fail("TOO_MANY_ATTEMPTS", "Too many newsletter requests. Please try again in 15 minutes.", 429);
    }
  }
  async function lockStore(store, connection, allowInactive = false) {
    if (!await dao.lockStore({ ...store, allowInactive, connection })) fail("STORE_NOT_FOUND", "This store is unavailable.", 404);
  }
  return {
    scope,
    async ipLimit(store, ip) { await throttle(store, `ip:${ip || "unknown"}`, 300); },
    async subscribe(store, input) {
      if (input.consent !== true) fail("NEWSLETTER_CONSENT_REQUIRED", "Please agree to receive the newsletter first.", 422);
      await throttle(store, `email:${input.email}`, 3);
      mailer.ready(store);
      const confirmToken = secret(); const unsubscribeToken = secret(); const confirmHash = digest(confirmToken);
      const subscriberId = await transaction(store.tenantId, async (connection) => {
        await lockStore(store, connection);
        const previous = await dao.findSubscriber({ ...store, email: input.email, connection });
        if (previous?.status === "ACTIVE") return null;
        const id = previous?.id || createId();
        await dao.requestConfirmation({ scope: store, subscriberId: id, email: input.email, confirmHash,
          unsubscribeHash: digest(unsubscribeToken), consentVersion: CONSENT_VERSION, exists: Boolean(previous), connection });
        await dao.audit({ ...store, subscriberId: id, action: "newsletter.confirmation_requested",
          data: { storeId: store.storeId, consentVersion: CONSENT_VERSION, previousStatus: previous?.status || null }, connection });
        return id;
      });
      if (!subscriberId) return accepted;
      try { await mailer.send({ scope: store, email: input.email, confirmToken, unsubscribeToken }); }
      catch {
        await dao.recordDelivery({ scope: store, subscriberId, confirmHash, sent: false });
        throw emailUnavailable();
      }
      await dao.recordDelivery({ scope: store, subscriberId, confirmHash, sent: true });
      return accepted;
    },
    async confirm(store, { token }) {
      return transaction(store.tenantId, async (connection) => {
        await lockStore(store, connection);
        const subscriber = await dao.findToken({ scope: store, tokenHash: digest(token), connection });
        if (!subscriber || !subscriber.tokenCurrent || !["PENDING", "ACTIVE"].includes(subscriber.status)) {
          fail("NEWSLETTER_LINK_INVALID", "This confirmation link is invalid or expired. Request a new link from the newsletter form.", 410);
        }
        if (subscriber.status !== "ACTIVE") {
          await dao.activate({ scope: store, subscriberId: subscriber.id, connection });
          await dao.audit({ ...store, subscriberId: subscriber.id, action: "newsletter.subscription_confirmed",
            data: { storeId: store.storeId, consentVersion: subscriber.consentVersion }, connection });
        }
        return { message: "Your newsletter subscription is confirmed. You can unsubscribe using the link in your confirmation email." };
      });
    },
    async unsubscribe(store, { token }) {
      return transaction(store.tenantId, async (connection) => {
        await lockStore(store, connection, true);
        const subscriber = await dao.findToken({ scope: store, tokenHash: digest(token), unsubscribe: true, connection });
        if (!subscriber) fail("NEWSLETTER_LINK_INVALID", "This unsubscribe link is invalid. Use your latest confirmation email or contact the store.", 410);
        if (subscriber.status !== "UNSUBSCRIBED") {
          await dao.unsubscribe({ ...store, subscriberId: subscriber.id, connection });
          await dao.audit({ ...store, subscriberId: subscriber.id, action: "newsletter.unsubscribed",
            data: { storeId: store.storeId, source: "EMAIL_LINK" }, connection });
        }
        return { message: "You are unsubscribed from this store's newsletter." };
      });
    },
    list: (tenantId, filters) => dao.listSubscribers({ tenantId, filters }),
    async adminUnsubscribe(tenantId, subscriberId, input, context) {
      if (input.confirmed !== true) fail("NEWSLETTER_CONFIRMATION_REQUIRED", "Confirm this unsubscribe request first.", 422);
      return transaction(tenantId, async (connection) => {
        const subscriber = await dao.findSubscriber({ tenantId, subscriberId, connection });
        if (!subscriber) fail("NEWSLETTER_SUBSCRIBER_NOT_FOUND", "Subscriber was not found.", 404);
        if (subscriber.status === "UNSUBSCRIBED") return { message: "This subscriber is already unsubscribed." };
        if (subscriber.revision !== input.expectedRevision) fail("NEWSLETTER_REVISION_CONFLICT", "This subscription changed. Refresh before trying again.", 409);
        await dao.unsubscribe({ tenantId, subscriberId, connection });
        await dao.audit({ tenantId, subscriberId, action: "newsletter.admin_unsubscribed", context,
          data: { storeId: subscriber.storeId, previousStatus: subscriber.status, reason: input.reason }, connection });
        return { message: "Subscriber unsubscribed. Only the email owner can request and confirm a new subscription." };
      });
    }
  };
}
