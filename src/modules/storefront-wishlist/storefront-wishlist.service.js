import { randomBytes } from "node:crypto";
import { AppError } from "../../core/errors/app-error.js";
import { withTransaction } from "../../database/transaction.js";
import { resolveStore, wishlistProducts } from "../storefront/storefront.dao.js";
import { digest } from "../customer-accounts/customer-accounts.service.js";
import * as accounts from "../customer-accounts/customer-accounts.dao.js";
import * as defaultDao from "./storefront-wishlist.dao.js";

const fail = (code, message, status = 409) => { throw new AppError({ code, message, status }); };
const tokenValid = (token) => /^[a-f0-9]{64}$/.test(token || "");
const limitItems = (ids) => { if (ids.length > 100) fail("WISHLIST_LIMIT", "A wishlist can hold 100 products. Remove some items before adding or merging more."); };
export function createStorefrontWishlistService({ dao = defaultDao, accountDao = accounts, storeResolver = resolveStore,
  products = wishlistProducts, transaction = withTransaction } = {}) {
  return {
    async scope(params) {
      const store = await storeResolver(params);
      if (!store) fail("STORE_NOT_FOUND", "This store is unavailable.", 404);
      return store;
    },
    async limit(store, ip) {
      if (!await accountDao.limit({ bucketHash: digest(`${store.tenantId}:wishlist:${ip}`), maximum: 180 })) fail("TOO_MANY_ATTEMPTS", "Too many wishlist requests. Please try again shortly.", 429);
    },
    async operate(store, identity, operation, input) {
      return transaction(store.tenantId, async (connection) => {
        let customer;
        if (identity.sessionToken) {
          customer = tokenValid(identity.sessionToken) && await accountDao.session({ ...store, tokenHash: digest(identity.sessionToken), connection });
          if (!customer || customer.status !== "ACTIVE" || customer.deletedAt) fail("CUSTOMER_AUTHENTICATION_REQUIRED", "Sign in again to access your wishlist.", 401);
          await accountDao.findAccount({ ...store, customerId: customer.customerId, lock: true, connection });
          const current = await accountDao.session({ ...store, tokenHash: digest(identity.sessionToken), lock: true, connection });
          if (!current || current.status !== "ACTIVE" || current.deletedAt) fail("CUSTOMER_AUTHENTICATION_REQUIRED", "Sign in again to access your wishlist.", 401);
          customer = current;
        }
        const guestToken = tokenValid(identity.guestToken) ? identity.guestToken : randomBytes(32).toString("hex");
        const guestKey = { ...store, ownerHash: digest(`guest:${guestToken}`), connection };
        const key = customer ? { ...store, ownerHash: digest(`customer:${customer.customerId}`), customerId: customer.customerId, connection } : guestKey;
        const listKey = digest(`${store.tenantId}:${store.storeId}:${key.ownerHash.toString("hex")}`).toString("hex");
        if (operation === "sync") await dao.ensure(key);
        let list = await dao.read(key);
        if (!list) fail("WISHLIST_CHANGED", "Refresh your wishlist and try again.");
        if (list.expired || list.consumed) fail("WISHLIST_EXPIRED", "This guest wishlist expired or was moved to an account. Refresh to start a new list.", 410);
        let merged = false;
        if (operation === "sync") {
          // Import legacy IDs once per guest token, never trust browser snapshots or prices.
          let guest = customer ? null : list;
          if (customer && (identity.guestToken || input.legacyProductIds.length)) {
            await dao.ensure(guestKey); guest = await dao.read(guestKey);
          }
          if (guest && !guest.expired && !guest.consumed) {
            if (!guest.legacyImported) {
              const eligible = await products({ scope: store, productIds: input.legacyProductIds, connection });
              guest.productIds = [...new Set([...guest.productIds, ...eligible.map((product) => product.id)])];
              limitItems(guest.productIds); guest.legacyImported = true;
              await dao.save({ ...guestKey, ...guest }); guest.revision++;
            }
            if (customer) {
              const combined = [...new Set([...list.productIds, ...guest.productIds])]; limitItems(combined);
              if (combined.length !== list.productIds.length) { list.productIds = combined; await dao.save({ ...key, ...list }); list.revision++; }
              merged = guest.productIds.length > 0;
              await dao.consume(guestKey);
            } else list = guest;
          }
        } else {
          if (input.listKey !== listKey || input.revision !== list.revision) fail("WISHLIST_CHANGED", "Your wishlist or account changed. Refresh it and try again.");
          if (input.saved && !list.productIds.includes(input.productId)) {
            const [product] = await products({ scope: store, productIds: [input.productId], connection });
            if (!product) fail("PRODUCT_UNAVAILABLE", "This product is no longer available in this store.", 404);
            limitItems([...list.productIds, input.productId]); list.productIds = [input.productId, ...list.productIds];
          } else if (!input.saved) list.productIds = list.productIds.filter((id) => id !== input.productId);
          await dao.save({ ...key, ...list }); list.revision++;
        }
        const live = await products({ scope: store, productIds: list.productIds, connection });
        const byId = new Map(live.map((product) => [product.id, product]));
        return { listKey, revision: list.revision, mode: customer ? "customer" : "guest", merged,
          items: list.productIds.map((productId) => ({ productId, product: byId.get(productId) || null })),
          guestToken: customer ? null : guestToken };
      });
    }
  };
}
