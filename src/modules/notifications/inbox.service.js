import { createHash } from "node:crypto";
import { AppError } from "../../core/errors/app-error.js";
import { getPrimaryPool } from "../../database/pool-factory.js";
import * as defaultDao from "./inbox.dao.js";
import * as accountDao from "../customer-accounts/customer-accounts.dao.js";
import { resolveStore } from "../storefront/storefront.dao.js";
import { findPlatformAccess } from "../platform-access/platform-access.dao.js";

const fail = (code, message, status) => { throw new AppError({ code, message, status }); };
export function createInboxService({ dao = defaultDao, accounts = accountDao,
  storeResolver = resolveStore, platformAccess = findPlatformAccess } = {}) {
  async function userScope(context, audience) {
    const actor = context.actor;
    if (!actor || !await dao.activeSession(actor)) fail("AUTHENTICATION_REQUIRED", "Your session is invalid or has expired.", 401);
    if (audience === "PLATFORM") {
      const access = await platformAccess({ userId: actor.userId });
      if (!access) fail("FORBIDDEN", "You do not have access to platform notifications.", 403);
      return { recipientId: actor.userId, audience, permissions: access.permissions, unrestricted: access.unrestricted };
    }
    const scope = audience === "VENDOR" ? context.vendor : context.tenant;
    if (!scope) fail("FORBIDDEN", "Select an authorised workspace.", 403);
    return { recipientId: actor.userId, tenantId: scope.tenantId, merchantId: scope.merchantId, audience,
      permissions: [...new Set(scope.assignments.filter((a) => audience === "VENDOR"
        ? a.roleLevel === "VENDOR" && a.scopeType === "MERCHANT" && a.scopeId === scope.merchantId
        : a.scopeType === "TENANT" && a.scopeId === scope.tenantId).flatMap((a) => a.permissions))] };
  }
  async function customerScope(params, token) {
    const store = await storeResolver(params);
    if (!store) fail("STORE_NOT_FOUND", "This store is unavailable.", 404);
    const account = /^[a-f0-9]{64}$/.test(token || "") ? await accounts.session({ tenantId: store.tenantId,
      tokenHash: createHash("sha256").update(token).digest() }) : null;
    if (!account || account.status !== "ACTIVE" || account.deletedAt) fail("CUSTOMER_AUTHENTICATION_REQUIRED", "Please sign in to your customer account.", 401);
    return { audience: "CUSTOMER", recipientId: account.customerId, tenantId: store.tenantId, storeId: store.storeId };
  }
  return {
    userScope, customerScope,
    async list(scope, filters) {
      const result = await dao.list({ scope, ...filters });
      return { ...result, page: filters.page, pageSize: filters.pageSize,
        totalPages: Math.max(1, Math.ceil(result.total / filters.pageSize)) };
    },
    async unread(scope) { return { unreadCount: await dao.unreadCount({ scope }) }; },
    async mark(scope, notificationId, read) {
      if (!await dao.markRead({ scope, notificationId, read })) fail("NOTIFICATION_NOT_FOUND", "This notification is unavailable.", 404);
      return { id: notificationId, read };
    },
    async markAll(scope, throughId) {
      if (!await dao.markAllRead({ scope, throughId })) fail("NOTIFICATION_NOT_FOUND", "The notification cutoff is unavailable. Refresh your inbox.", 404);
      return { throughId, read: true };
    }
  };
}
export function createInboxWorker({ dao = defaultDao, pool = getPrimaryPool() } = {}) {
  return { async once() {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await dao.processNext({ connection });
      await connection.commit();
      return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  } };
}
