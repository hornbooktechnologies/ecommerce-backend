import { randomBytes } from "node:crypto";
import Decimal from "decimal.js";
import { AppError } from "../../core/errors/app-error.js";
import { withTransaction } from "../../database/transaction.js";
import { resolveStore, cartOffers } from "../storefront/storefront.dao.js";
import { digest } from "../customer-accounts/customer-accounts.service.js";
import * as accounts from "../customer-accounts/customer-accounts.dao.js";
import * as defaultDao from "./storefront-cart.dao.js";

const fail = (code, message, status = 422) => { throw new AppError({ code, message, status }); };
export function quantityIssue(product, quantity) {
  if (!product) return "This item is no longer available. Remove it from your bag.";
  const minimum = new Decimal(product.minimumOrderQuantity);
  const maximum = Math.min(product.availableQuantity, product.maximumOrderQuantity ?? product.availableQuantity);
  if (maximum < Number(minimum)) return "This item is currently out of stock.";
  if (quantity > maximum) return `Only ${maximum} ${product.uom} can be ordered now. Reduce the quantity.`;
  if (new Decimal(quantity).lt(minimum) || !new Decimal(quantity).minus(minimum).mod(product.quantityStep).isZero()) {
    return `Choose at least ${minimum} ${product.uom}, in steps of ${product.quantityStep}.`;
  }
  return null;
}

export function createStorefrontCartService({ dao = defaultDao, accountDao = accounts, storeResolver = resolveStore,
  offers = cartOffers, transaction = withTransaction } = {}) {
  async function scope(params) {
    const store = await storeResolver(params);
    if (!store) fail("STORE_NOT_FOUND", "This store is unavailable.", 404);
    return store;
  }
  async function operate(store, identity, operation, input = {}) {
    return transaction(store.tenantId, async (connection) => {
      let customer;
      if (identity.sessionToken) {
        customer = /^[a-f0-9]{64}$/.test(identity.sessionToken) && await accountDao.session({ ...store, tokenHash: digest(identity.sessionToken), connection });
        if (!customer || customer.status !== "ACTIVE" || customer.deletedAt) fail("CUSTOMER_AUTHENTICATION_REQUIRED", "Your customer session expired. Please sign in again.", 401);
        await accountDao.findAccount({ ...store, customerId: customer.customerId, lock: true, connection });
        const current = await accountDao.session({ ...store, tokenHash: digest(identity.sessionToken), connection, lock: true });
        if (!current || current.status !== "ACTIVE" || current.deletedAt) fail("CUSTOMER_AUTHENTICATION_REQUIRED", "Please sign in again.", 401);
      }
      const guestToken = /^[a-f0-9]{64}$/.test(identity.guestToken || "") ? identity.guestToken : randomBytes(32).toString("hex");
      const guestKey = { ...store, ownerHash: digest(`guest:${guestToken}`), connection };
      const key = customer ? { ...store, ownerHash: digest(`customer:${customer.customerId}`), customerId: customer.customerId, connection } : guestKey;
      const cartKey = digest(`${store.tenantId}:${store.storeId}:${key.ownerHash.toString("hex")}`).toString("hex");
      if (operation !== "sync") {
        const existing = await dao.read(key);
        if (!existing || existing.expired) fail("CART_CHANGED", "Your bag changed. Refresh it and try again.", 409);
      } else await dao.ensure(key);
      let cart = await dao.read(key);
      if (cart.expired) {
        // Never resurrect an expired guest token, including a stale browser cookie.
        fail("CART_EXPIRED", "Your guest bag expired. Reload to start a new bag.", 410);
      }
      let merged = false;
      if (operation === "sync" && customer && !cart.legacyImported) {
        const quantities = new Map(cart.items.map((line) => [line.offerId, line.quantity]));
        for (const line of input.legacyItems || []) quantities.set(line.offerId, Number(new Decimal(quantities.get(line.offerId) || 0).plus(line.quantity)));
        if (quantities.size > 50 || [...quantities.values()].some((value) => value > 1000000)) fail("CART_MERGE_LIMIT", "Reduce your bag to 50 items before merging.", 409);
        cart.items = [...quantities].map(([offerId, quantity]) => ({ offerId, quantity }));
        cart.legacyImported = true;
        await dao.save({ ...key, ...cart }); cart.revision++;
      }
      if (operation === "sync" && customer && identity.guestToken) {
        const guest = await dao.read(guestKey);
        if (guest && !guest.expired && guest.items.length) {
          const quantities = new Map(cart.items.map((line) => [line.offerId, line.quantity]));
          for (const line of guest.items) quantities.set(line.offerId, Number(new Decimal(quantities.get(line.offerId) || 0).plus(line.quantity)));
          if (quantities.size > 50 || [...quantities.values()].some((value) => value > 1000000)) fail("CART_MERGE_LIMIT", "The combined bags exceed the bag limit. Sign out and reduce the guest bag before merging.", 409);
          cart.items = [...quantities].map(([offerId, quantity]) => ({ offerId, quantity }));
          await dao.save({ ...key, ...cart }); cart.revision++;
          await dao.save({ ...guestKey, items: [], legacyImported: true });
          merged = true;
        }
      }
      if (operation === "sync" && !customer && !cart.legacyImported) {
        const imported = input.legacyItems || [];
        // Legacy browser snapshots contribute identifiers/quantities only, never prices.
        if (!cart.items.length) cart.items = imported;
        cart.legacyImported = true;
        await dao.save({ ...key, ...cart }); cart.revision++;
      }
      if (operation !== "sync") {
        if (input.cartKey !== cartKey || input.revision !== cart.revision) fail("CART_CHANGED", "Your bag or account changed in another tab. It has been refreshed; try again.", 409);
        if (operation === "clear") cart.items = [];
        else if (input.quantity === 0) cart.items = cart.items.filter((line) => line.offerId !== input.offerId);
        else {
          const [product] = await offers({ scope: store, offerIds: [input.offerId], connection });
          const issue = quantityIssue(product, input.quantity);
          if (issue) fail("CART_QUANTITY_INVALID", issue);
          if (!cart.items.some((line) => line.offerId === input.offerId) && cart.items.length >= 50) fail("CART_LIMIT", "A bag can contain up to 50 different items.");
          cart.items = [...cart.items.filter((line) => line.offerId !== input.offerId), { offerId: input.offerId, quantity: input.quantity }];
        }
        await dao.save({ ...key, ...cart }); cart.revision++;
      }
      const products = await offers({ scope: store, offerIds: cart.items.map((line) => line.offerId), connection });
      const byId = new Map(products.map((product) => [product.offerId, product]));
      const items = cart.items.map((line) => {
        const product = byId.get(line.offerId) || null;
        const issue = quantityIssue(product, line.quantity);
        return { ...line, product, issue, lineTotal: product ? Number(new Decimal(product.price).times(line.quantity).toDecimalPlaces(2)) : null };
      });
      return { cartKey, revision: cart.revision, mode: customer ? "customer" : "guest", items, currency: store.currency,
        subtotal: Number(items.reduce((sum, line) => sum.plus(line.lineTotal || 0), new Decimal(0)).toDecimalPlaces(2)),
        hasIssues: items.some((line) => line.issue), merged, guestToken: customer ? null : guestToken };
    });
  }
  return { scope, operate,
    async limit(store, ip) {
      if (!await accountDao.limit({ bucketHash: digest(`${store.tenantId}:cart:${ip}`), maximum: 180 })) fail("TOO_MANY_ATTEMPTS", "Too many bag requests. Please try again shortly.", 429);
    }
  };
}
