import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { hashPassword, verifyPassword } from "../../core/security/password.js";
import { withTransaction } from "../../database/transaction.js";
import { resolveStore } from "../storefront/storefront.dao.js";
import { insertCustomer } from "../orders/orders.dao.js";
import * as defaultDao from "./customer-accounts.dao.js";
import { createCustomerMailer } from "./customer-accounts.mail.js";
import { states } from "./customer-accounts.validators.js";
import * as defaultOrderDao from "./customer-orders.dao.js";
import { renderTaxDocumentPdf } from "../taxes/tax-document.pdf.js";
import * as defaultReviewDao from "./customer-reviews.dao.js";
import { createCustomerAfterSalesService } from "./customer-after-sales.service.js";

export const digest = (value) => createHash("sha256").update(value).digest();
const secret = () => randomBytes(32).toString("hex");
const dummyHash = ["scrypt", "16384", "8", "1", Buffer.alloc(16).toString("base64url"), Buffer.alloc(64).toString("base64url")].join(":");
const fail = (code, message, status = 422, field) => { throw new AppError({ code, message, status, details: field ? [{ field, message }] : [] }); };
const available = (account) => account && account.status === "ACTIVE" && !account.deletedAt;
const publicAccount = ({ customerId, email, firstName, lastName, phone }) => ({ id: customerId, email, firstName, lastName, phone });
const genericEmail = { message: "If this email is eligible, a link has been sent. Check your inbox and spam folder. Existing customers can sign in or reset their password." };

export function createCustomerAccountsService({ dao = defaultDao, storeResolver = resolveStore, createCustomer = insertCustomer,
  mailer = createCustomerMailer(), transaction = withTransaction, orderDao = defaultOrderDao, reviewDao = defaultReviewDao,
  afterSales = createCustomerAfterSalesService(), pdfRenderer = renderTaxDocumentPdf } = {}) {
  async function scope(params) {
    const store = await storeResolver(params);
    if (!store) fail("STORE_NOT_FOUND", "This store is unavailable.", 404);
    return { ...store, tenantCode: params.tenantCode, storeCode: params.storeCode };
  }
  async function throttle(store, key, maximum) {
    if (!await dao.limit({ bucketHash: digest(`${store.tenantId}:${key}`), maximum })) fail("TOO_MANY_ATTEMPTS", "Too many attempts. Please try again in 15 minutes.", 429);
  }
  async function auth(store, token, connection) {
    const account = /^[a-f0-9]{64}$/.test(token || "") ? await dao.session({ tenantId: store.tenantId, tokenHash: digest(token), connection }) : null;
    if (!available(account)) fail("CUSTOMER_AUTHENTICATION_REQUIRED", "Please sign in to your customer account.", 401);
    return account;
  }
  async function withAccount(store, token, operation) {
    const initial = await auth(store, token);
    return transaction(store.tenantId, async (connection) => {
      await dao.findAccount({ ...store, customerId: initial.customerId, connection, lock: true });
      const account = await auth(store, token, connection);
      return operation(account, connection);
    });
  }
  async function requestEmail(store, input, purpose) {
    mailer.ready(store);
    await throttle(store, `email:${purpose}:${input.email}`, 4);
    const token = secret();
    const send = await transaction(store.tenantId, async (connection) => {
      await dao.lockTenant({ ...store, connection });
      const account = await dao.findAccount({ ...store, email: input.email, connection, lock: true });
      if (purpose === "REGISTER" ? Boolean(account) : !available(account)) return false;
      if (purpose === "REGISTER") {
        const matches = await dao.findCustomers({ ...store, email: input.email, connection });
        if (matches.length > 1 || matches.some((customer) => customer.status !== "ACTIVE" || customer.deletedAt || customer.email.trim().toLowerCase() !== input.email)) return false;
      }
      await dao.insertToken({ ...store, ...input, purpose, tokenHash: digest(token), customerId: account?.customerId, connection });
      return true;
    });
    if (send) {
      try { await mailer.send({ scope: store, email: input.email, purpose, token }); }
      catch (error) { await dao.deleteTokens({ ...store, tokenHash: digest(token) }); throw error; }
    }
    return genericEmail;
  }
  async function redeem(store, input, purpose) {
    const passwordHash = await hashPassword(input.newPassword);
    await transaction(store.tenantId, async (connection) => {
      await dao.lockTenant({ ...store, connection });
      const token = await dao.findToken({ ...store, purpose, tokenHash: digest(input.token), connection });
      if (!token) fail("CUSTOMER_LINK_INVALID", "This link is invalid or expired. Request a new link.", 400);
      let account = await dao.findAccount({ ...store, email: token.email, connection, lock: true });
      let customerId = account?.customerId;
      if (purpose === "REGISTER") {
        if (account) fail("CUSTOMER_LINK_INVALID", "This link is no longer valid. Sign in or reset your password.", 400);
        const matches = await dao.findCustomers({ ...store, email: token.email, connection });
        if (matches.length > 1 || matches.some((customer) => customer.status !== "ACTIVE" || customer.deletedAt || customer.email.trim().toLowerCase() !== token.email)) fail("CUSTOMER_LINK_INVALID", "Please contact the store to activate this account.", 400);
        customerId = matches[0]?.id || createId();
        if (!matches.length) await createCustomer({ customer: { ...token, id: customerId, tenantId: store.tenantId, number: `WEB-${customerId.replaceAll("-", "")}`, phone: "", notes: "Created through verified storefront registration." }, connection });
        await dao.createAccount({ ...store, customerId, email: token.email, passwordHash, connection });
      } else {
        if (!available(account) || customerId !== token.customerId) fail("CUSTOMER_LINK_INVALID", "This link is no longer valid. Request a new link.", 400);
        await dao.password({ ...store, customerId, passwordHash, connection });
        await dao.revoke({ ...store, customerId, connection });
      }
      await dao.deleteTokens({ ...store, email: token.email, connection });
      await dao.audit({ ...store, customerId, action: purpose === "REGISTER" ? "CUSTOMER_ACCOUNT_VERIFIED" : "CUSTOMER_PASSWORD_RESET", connection });
    });
    return { message: purpose === "REGISTER" ? "Email verified. Your account is ready. Please sign in." : "Password reset. Please sign in with your new password." };
  }
  return {
    scope,
    async ipLimit(store, ip) { await throttle(store, `ip:${ip}`, 300); await dao.pruneExpired({}); },
    register: (store, input) => requestEmail(store, input, "REGISTER"),
    forgot: (store, input) => requestEmail(store, input, "RESET"),
    verify: (store, input) => redeem(store, input, "REGISTER"),
    reset: (store, input) => redeem(store, input, "RESET"),
    async login(store, input) {
      await throttle(store, `login:${input.email}`, 10);
      return transaction(store.tenantId, async (connection) => {
        const account = await dao.findAccount({ ...store, email: input.email, connection, lock: true });
        const matches = await verifyPassword(input.password, account?.passwordHash || dummyHash);
        if (!available(account) || !matches) fail("CUSTOMER_INVALID_CREDENTIALS", "The email or password is incorrect, or the account is unavailable.", 401);
        const token = secret();
        await dao.insertSession({ ...store, customerId: account.customerId, tokenHash: digest(token), connection });
        await dao.audit({ ...store, customerId: account.customerId, action: "CUSTOMER_SIGNED_IN", connection });
        return { sessionToken: token, expiresIn: 3600, customer: publicAccount(account) };
      });
    },
    async logout(store, token) {
      if (/^[a-f0-9]{64}$/.test(token || "")) await dao.revoke({ ...store, tokenHash: digest(token) });
      return { message: "Signed out." };
    },
    async me(store, token) {
      const account = await auth(store, token);
      return { customer: publicAccount(account), addresses: await dao.addresses({ ...store, customerId: account.customerId }), states };
    },
    async orders(store, token, input) {
      return withAccount(store, token, (account, connection) => orderDao.listOrders({ ...store,
        customerId: account.customerId, page: input.page, pageSize: input.pageSize, connection }));
    },
    async order(store, token, input) {
      return withAccount(store, token, async (account, connection) => {
        const result = await orderDao.readOrder({ ...store, customerId: account.customerId, orderId: input.orderId, connection });
        if (!result) fail("CUSTOMER_ORDER_NOT_FOUND", "This order is unavailable in your account.", 404);
        return result;
      });
    },
    async afterSales(store, token, input) {
      return withAccount(store, token, (account, connection) => afterSales.read({ ...store, customerId: account.customerId, orderId: input.orderId, connection }));
    },
    async cancelOrder(store, token, input) {
      return withAccount(store, token, (account, connection) => afterSales.cancel({ ...store, customerId: account.customerId, orderId: input.orderId, connection }, input));
    },
    async requestReturn(store, token, input) {
      return withAccount(store, token, (account, connection) => afterSales.requestReturn({ ...store, customerId: account.customerId, orderId: input.orderId, connection }, input));
    },
    async review(store, token, input) {
      return withAccount(store, token, async (account, connection) => {
        const args = { ...store, customerId: account.customerId, orderId: input.orderId, orderItemId: input.orderItemId, connection };
        const purchase = await reviewDao.purchase(args);
        if (!purchase) fail("CUSTOMER_ORDER_ITEM_NOT_FOUND", "This item is unavailable in your account.", 404);
        const previous = await reviewDao.existing(args);
        if (previous) return { review: previous, message: "Your review has already been received." };
        if (!purchase.eligible) fail("REVIEW_NOT_ELIGIBLE", "You can review this item after delivery is completed.", 422);
        const reviewId = createId();
        await reviewDao.insert({ ...args, productId: purchase.productId, reviewId, account, input });
        await dao.audit({ ...args, action: "CUSTOMER_PRODUCT_REVIEW_SUBMITTED" });
        return { review: { id: reviewId, status: "PENDING" }, message: "Thank you. Your review is awaiting moderation." };
      });
    },
    async invoice(store, token, input) {
      const document = await withAccount(store, token, async (account, connection) => {
        const result = await orderDao.readInvoice({ ...store, customerId: account.customerId,
          orderId: input.orderId, documentId: input.documentId, connection });
        if (!result || result.status !== "ISSUED" || result.documentType !== "TAX_INVOICE") {
          fail("CUSTOMER_INVOICE_NOT_FOUND", "This invoice is unavailable in your account.", 404);
        }
        return result;
      });
      // Keep the existing vendor-branded layout without exposing the staff issuer's name.
      const buffer = await pdfRenderer({ ...document, issuedByName: document.seller.legalName });
      return { buffer, filename: `tax-invoice-${document.documentNumber.replace(/[^A-Za-z0-9_-]+/g, "-")}.pdf` };
    },
    async updateProfile(store, token, input) {
      await withAccount(store, token, async (account, connection) => {
        await dao.profile({ ...store, customerId: account.customerId, input, connection });
        await dao.audit({ ...store, customerId: account.customerId, action: "CUSTOMER_PROFILE_UPDATED", connection });
      });
      return this.me(store, token);
    },
    async changePassword(store, token, input) {
      const initial = await auth(store, token);
      await throttle(store, `password:${initial.customerId}`, 10);
      await withAccount(store, token, async (account, connection) => {
        if (!await verifyPassword(input.currentPassword, account.passwordHash)) fail("CURRENT_PASSWORD_INCORRECT", "The current password is incorrect.", 422, "currentPassword");
        if (input.currentPassword === input.newPassword) fail("PASSWORD_REUSED", "Choose a different password.", 422, "newPassword");
        await dao.password({ ...store, customerId: account.customerId, passwordHash: await hashPassword(input.newPassword), connection });
        await dao.revoke({ ...store, customerId: account.customerId, connection });
        await dao.deleteTokens({ ...store, email: account.email, connection });
        await dao.audit({ ...store, customerId: account.customerId, action: "CUSTOMER_PASSWORD_CHANGED", connection });
      });
      return { message: "Password changed. All sessions were signed out. Please sign in again." };
    },
    async address(store, token, addressId, input, remove = false) {
      await withAccount(store, token, async (account, connection) => {
        const args = { ...store, customerId: account.customerId, connection };
        const list = await dao.addresses(args);
        const existing = list.find((item) => item.id === addressId);
        if (addressId && !existing) fail("ADDRESS_NOT_FOUND", "Address not found.", 404);
        if (remove) {
          await dao.deleteAddress({ ...args, addressId });
          const remaining = list.filter((item) => item.id !== addressId);
          if (existing.isDefault && remaining[0]) await dao.saveAddress({ ...args, addressId: remaining[0].id, input: { ...remaining[0], isDefault: true }, exists: true });
        } else {
          if (!addressId && list.length >= 20) fail("ADDRESS_LIMIT", "You can save up to 20 delivery addresses.");
          await dao.saveAddress({ ...args, addressId: addressId || createId(), linkId: createId(), exists: Boolean(existing),
            input: { ...input, stateName: states[input.stateCode], isDefault: input.isDefault || list.length === 0 || Boolean(existing?.isDefault) } });
        }
        await dao.audit({ ...args, action: remove ? "CUSTOMER_ADDRESS_DELETED" : "CUSTOMER_ADDRESS_SAVED" });
      });
      return this.me(store, token);
    }
  };
}
