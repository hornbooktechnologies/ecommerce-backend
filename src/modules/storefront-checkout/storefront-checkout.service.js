import Decimal from "decimal.js";
import { createId } from "../../core/identifiers/uuid.js";
import { AppError } from "../../core/errors/app-error.js";
import { withTransaction } from "../../database/transaction.js";
import { digest } from "../customer-accounts/customer-accounts.service.js";
import { states } from "../customer-accounts/customer-accounts.validators.js";
import * as accounts from "../customer-accounts/customer-accounts.dao.js";
import * as carts from "../storefront-cart/storefront-cart.dao.js";
import { quantityIssue } from "../storefront-cart/storefront-cart.service.js";
import { cartOffers, resolveStore } from "../storefront/storefront.dao.js";
import * as orders from "../orders/orders.dao.js";
import { createOrdersService } from "../orders/orders.service.js";
import * as defaultDao from "./storefront-checkout.dao.js";
import { checkDeliveryAvailability } from "../storefront/delivery-availability.service.js";
import { createPaymentsService } from "../payments/payments.service.js";

const fail = (code, message, status = 409) => { throw new AppError({ code, message, status }); };
const fingerprint = (input, review, slot) => digest(JSON.stringify({ input, review, slot: [slot.id, slot.startsAt, slot.endsAt] })).toString("hex");
export function createStorefrontCheckoutService({ dao = defaultDao, accountDao = accounts, cartDao = carts, orderDao = orders,
  offers = cartOffers, storeResolver = resolveStore, transaction = withTransaction, orderFactory = createOrdersService, delivery = checkDeliveryAvailability,
  payments = createPaymentsService() } = {}) {
  async function scope(params) {
    const store = await storeResolver(params);
    if (!store) fail("STORE_NOT_FOUND", "This store is unavailable.", 404);
    return store;
  }
  async function authenticated(store, token, operation) {
    return transaction(store.tenantId, async (connection) => {
      const account = /^[a-f0-9]{64}$/.test(token || "") && await accountDao.session({ ...store, tokenHash: digest(token), connection });
      if (!account || account.status !== "ACTIVE" || account.deletedAt) fail("CUSTOMER_AUTHENTICATION_REQUIRED", "Sign in to your customer account to continue.", 401);
      await accountDao.findAccount({ ...store, customerId: account.customerId, lock: true, connection });
      const current = await accountDao.session({ ...store, tokenHash: digest(token), lock: true, connection });
      if (!current || current.status !== "ACTIVE" || current.deletedAt) fail("CUSTOMER_AUTHENTICATION_REQUIRED", "Your session expired. Sign in again.", 401);
      return operation(current, connection);
    });
  }
  const cartScope = (store, customer, connection) => ({ ...store, ownerHash: digest(`customer:${customer.customerId}`), connection });
  async function prepare(store, customer, cart, selection, connection) {
    if (!cart?.items.length) fail("CHECKOUT_EMPTY", "Your bag is empty. Add products before checkout.");
    const addresses = await accountDao.addresses({ ...store, customerId: customer.customerId, connection });
    const address = addresses.find((item) => item.id === selection.addressId);
    if (!address) fail("CHECKOUT_ADDRESS_UNAVAILABLE", "Choose a saved delivery address from your account.", 404);
    if (!address.phone || !address.line1 || !states[address.stateCode] || !/^[1-9][0-9]{5}$/.test(address.postalCode)) fail("CHECKOUT_ADDRESS_INCOMPLETE", "Update this address with a valid phone, state and PIN code.", 422);
    const live = await offers({ scope: store, offerIds: cart.items.map((line) => line.offerId), connection });
    for (const line of cart.items) {
      const product = live.find((item) => item.offerId === line.offerId);
      const issue = quantityIssue(product, line.quantity);
      if (issue) fail("CHECKOUT_STOCK_CHANGED", issue);
      if (!product.includesTax) fail("CHECKOUT_PRICE_CONFIGURATION", "This product needs tax-inclusive storefront pricing configured by the store before checkout.", 422);
    }
    const [slot] = await dao.slots({ ...store, postalCode: address.postalCode, slotId: selection.deliverySlotId, lock: true, connection });
    if (!slot) fail("CHECKOUT_SLOT_UNAVAILABLE", "This delivery slot is full, past its cutoff, or does not serve your PIN code. Choose another slot.");
    const saleSubtotal = cart.items.reduce((sum, line) => sum.plus(new Decimal(live.find((p) => p.offerId === line.offerId).price).times(line.quantity)), new Decimal(0));
    if (saleSubtotal.lt(slot.minimumOrderAmount)) fail("CHECKOUT_DELIVERY_MINIMUM", `Delivery to this zone requires an item subtotal of at least INR ${slot.minimumOrderAmount}.`, 422);
    if (slot.freeDeliveryThreshold !== null && saleSubtotal.gte(slot.freeDeliveryThreshold)) slot.deliveryFee = 0;
    const promotionId = selection.couponCode ? await dao.couponPromotion({ ...store, couponCode: selection.couponCode, connection }) : null;
    if (selection.couponCode && !promotionId) fail("COUPON_UNAVAILABLE", "This coupon is invalid or inactive. Check the code or remove it.", 422);
    const input = { storeId: store.storeId, customer: { firstName: customer.firstName, lastName: customer.lastName,
      email: customer.email, phone: address.phone }, shippingAddress: { contactName: address.contactName,
      line1: address.line1, line2: address.line2, landmark: address.landmark, city: address.city,
      stateCode: address.stateCode, stateName: states[address.stateCode], postalCode: address.postalCode },
    deliverySlotId: slot.id, promotionId, couponCode: selection.couponCode, customerNotes: selection.notes, internalNotes: "",
    items: cart.items.map((line) => ({ ...line, substitutionPreference: selection.substitutionPreference })) };
    // Use the authenticated customer, never the admin email-or-phone matching heuristic.
    // Use the storefront's dated price list and exact eligible offers, with the existing GST engine.
    const engine = orderFactory({ transaction: async (_tenant, operation) => operation(connection), dao: { ...orderDao,
      findCustomer: async () => ({ id: customer.customerId }),
      findPromotionForOrder: async (args) => {
        const promotion = await orderDao.findPromotionForOrder(args);
        return promotion ? { ...promotion, ...await dao.redemptionCounts(args) } : null;
      },
      findDeliverySlotForUpdate: async () => slot,
      findOffersForOrder: async (args) => {
        const taxRows = await orderDao.findOffersForOrder(args);
        return live.map((product) => {
          const row = taxRows.find((item) => item.id === product.offerId);
          return row ? { ...row, salePrice: product.price, listPrice: product.mrp, minimumOrderQuantity: product.minimumOrderQuantity,
            maximumOrderQuantity: product.maximumOrderQuantity, quantityStep: product.quantityStep, availableQuantity: product.availableQuantity,
            imageUrl: product.image } : null;
        }).filter(Boolean);
      }
    } });
    return { input, slot, engine };
  }
  return {
    scope,
    async limit(store, ip) {
      if (!await accountDao.limit({ bucketHash: digest(`${store.tenantId}:checkout:${ip}`), maximum: 90 })) fail("TOO_MANY_ATTEMPTS", "Too many checkout attempts. Please try again later.", 429);
    },
    options: (store, token, input) => authenticated(store, token, async (customer, connection) => {
      const addresses = await accountDao.addresses({ ...store, customerId: customer.customerId, connection });
      const address = addresses.find((item) => item.id === input.addressId);
      if (input.addressId && !address) fail("CHECKOUT_ADDRESS_UNAVAILABLE", "Choose an address from your account.", 404);
      const available = address ? await dao.slots({ ...store, postalCode: address.postalCode, connection }) : [];
      const deliveryAvailability = address ? await delivery({ ...store, postalCode: address.postalCode, connection }) : null;
      const previousAddresses = await dao.previousAddresses({ ...store, customerId: customer.customerId, savedAddresses: addresses, connection });
      return { addresses, previousAddresses, states, deliveryAvailability, paymentOptions: await payments.options({ ...store, connection }), slots: available.map(({ id, name, startsAt, endsAt, deliveryFee, minimumOrderAmount, freeDeliveryThreshold }) =>
        ({ id, name, startsAt, endsAt, deliveryFee, minimumOrderAmount, freeDeliveryThreshold })) };
    }),
    quote: (store, token, input) => authenticated(store, token, async (customer, connection) => {
      const key = cartScope(store, customer, connection);
      const cart = await cartDao.read(key);
      const cartKey = digest(`${store.tenantId}:${store.storeId}:${key.ownerHash.toString("hex")}`).toString("hex");
      if (!cart || cart.revision !== input.revision || input.cartKey !== cartKey) fail("CHECKOUT_CART_CHANGED", "Your bag changed. Return to your bag and refresh before reviewing checkout.");
      const { cartKey: ignored, revision, ...selection } = input;
      void ignored;
      const { input: orderInput, slot, engine } = await prepare(store, customer, cart, selection, connection);
      const review = await engine.createOrder(store.tenantId, orderInput, { preview: true });
      const paymentOptions = await payments.options({ ...store, connection });
      const paymentMethod = selection.paymentMethod || "COD";
      if (!(paymentMethod === "COD" ? paymentOptions.codEnabled : paymentOptions.onlineEnabled)) fail("PAYMENT_METHOD_UNAVAILABLE", "Choose an available payment method.");
      if (paymentMethod === "ONLINE_TEST" && review.items.some((item) => item.soldByWeight)) fail("WEIGHT_PAYMENT_UNAVAILABLE", "Choose cash on delivery for variable-weight items.", 422);
      selection.paymentMethod = paymentMethod;
      const quoteId = createId();
      const quote = { selection, review, address: orderInput.shippingAddress, slot: { id: slot.id, name: slot.name, startsAt: slot.startsAt, endsAt: slot.endsAt },
        fingerprint: fingerprint(orderInput, review, slot) };
      await dao.insertQuote({ ...store, customerId: customer.customerId, quoteId, revision, quote, connection });
      const saved = await dao.readQuote({ ...store, customerId: customer.customerId, quoteId, connection });
      return { quoteId, expiresAt: saved.expiresAt, review, address: quote.address, slot: quote.slot, paymentMethod };
    }),
    read: (store, token, { quoteId }) => authenticated(store, token, async (customer, connection) => {
      const saved = await dao.readQuote({ ...store, customerId: customer.customerId, quoteId, connection });
      if (!saved) fail("CHECKOUT_NOT_FOUND", "Checkout was not found for this account.", 404);
      return saved.receipt ? { receipt: await payments.read({ ...store, customerId: customer.customerId, connection }, saved.receipt, { refresh: true }) } : { quoteId, expired: saved.expired, expiresAt: saved.expiresAt,
        review: saved.quote.review, address: saved.quote.address, slot: saved.quote.slot, paymentMethod: saved.quote.selection.paymentMethod || "COD" };
    }),
    pay: (store, token, { quoteId }) => authenticated(store, token, async (customer, connection) => {
      const args = { ...store, customerId: customer.customerId, quoteId, connection };
      const saved = await dao.readQuote(args);
      if (!saved?.receipt) fail("CHECKOUT_NOT_FOUND", "Place this order before starting payment.", 404);
      return payments.start(args, saved.receipt);
    }),
    verify: (store, token, input) => authenticated(store, token, async (customer, connection) => {
      const args = { ...store, customerId: customer.customerId, quoteId: input.quoteId, connection };
      const saved = await dao.readQuote(args);
      if (!saved?.receipt) fail("CHECKOUT_NOT_FOUND", "Checkout was not found for this account.", 404);
      return payments.verify(args, saved.receipt, input);
    }),
    place: (store, token, { quoteId }, context = {}) => authenticated(store, token, async (customer, connection) => {
      const saved = await dao.readQuote({ ...store, customerId: customer.customerId, quoteId, connection });
      if (!saved) fail("CHECKOUT_NOT_FOUND", "Checkout was not found for this account.", 404);
      if (saved.receipt) return { receipt: await payments.read({ ...store, customerId: customer.customerId, connection }, saved.receipt) }; // Replay is safe.
      if (saved.expired) fail("CHECKOUT_EXPIRED", "Your review expired. Review your order again before placing it.");
      const key = cartScope(store, customer, connection);
      const cart = await cartDao.read(key);
      if (!cart || cart.revision !== saved.revision) fail("CHECKOUT_CART_CHANGED", "Your bag changed. Review the updated bag before placing the order.");
      const { input, slot, engine } = await prepare(store, customer, cart, saved.quote.selection, connection);
      const result = await engine.createOrder(store.tenantId, input, { ...context, actorUserId: null, source: "STOREFRONT",
        verifyReview: (review) => {
          if (fingerprint(input, review, slot) !== saved.quote.fingerprint) fail("CHECKOUT_CHANGED", "Pricing, delivery or address details changed. Review the updated order before submitting.");
        } });
      const { id, orderNumber, grandTotal, currency, placedAt } = result.order;
      const paymentMethod = saved.quote.selection.paymentMethod || "COD";
      await payments.attach({ ...store, customerId: customer.customerId, connection }, result.order, paymentMethod, saved.quote.review);
      const receipt = { id, orderNumber, grandTotal, currency, placedAt, status: "PLACED", paymentStatus: "UNPAID",
        quoteId, paymentMethod, testMode: paymentMethod === "ONLINE_TEST", canPay: paymentMethod === "ONLINE_TEST",
        message: paymentMethod === "COD" ? "Order received. Pay on delivery. No payment has been collected online."
          : "Order saved. Complete your test payment below. No real money will be collected." };
      await dao.complete({ ...store, customerId: customer.customerId, quoteId, receipt, connection });
      await cartDao.save({ ...key, items: [], legacyImported: true });
      return { receipt: await payments.read({ ...store, customerId: customer.customerId, connection }, receipt) };
    })
  };
}
