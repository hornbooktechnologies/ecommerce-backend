import test from "node:test";
import assert from "node:assert/strict";
import { createId, uuidToBuffer } from "../src/core/identifiers/uuid.js";
import { previousAddresses } from "../src/modules/storefront-checkout/storefront-checkout.dao.js";
import { digest } from "../src/modules/customer-accounts/customer-accounts.service.js";
import { createStorefrontCheckoutService } from "../src/modules/storefront-checkout/storefront-checkout.service.js";
import { checkoutSchemas } from "../src/modules/storefront-checkout/storefront-checkout.routes.js";
import { validate } from "../src/modules/customer-accounts/customer-accounts.validators.js";

function setup() {
  const scope = { tenantId: createId(), storeId: createId(), currency: "INR" };
  const customerId = createId(), addressId = createId(), offerId = createId(), slotId = createId();
  const rows = new Map(); const counts = { orders: 0 };
  const product = { offerId, price: 100, mrp: 100, includesTax: true, availableQuantity: 10, minimumOrderQuantity: 1, maximumOrderQuantity: null, quantityStep: 1, uom: "PCS" };
  const cart = { revision: 2, items: [{ offerId, quantity: 1 }] };
  const slot = { id: slotId, startsAt: "2099-01-01T00:00:00Z", endsAt: "2099-01-01T01:00:00Z", deliveryFee: 20, minimumOrderAmount: 0, freeDeliveryThreshold: null };
  const account = { customerId, firstName: "Test", lastName: "Customer", email: "checkout@example.invalid", status: "ACTIVE" };
  const key = digest(`customer:${customerId}`).toString("hex");
  const input = { addressId, deliverySlotId: slotId, couponCode: "", notes: "", substitutionPreference: "CONTACT_ME", revision: 2,
    cartKey: digest(`${scope.tenantId}:${scope.storeId}:${key}`).toString("hex") };
  const service = createStorefrontCheckoutService({ transaction: async (_tenant, fn) => fn({}), storeResolver: async () => scope,
    payments: { options: async () => ({ codEnabled: true, onlineEnabled: false }), attach: async () => {}, read: async (_scope, receipt) => receipt },
    delivery: async ({ postalCode }) => ({ postalCode, status: "FULL", message: "All slots are full." }),
    accountDao: { session: async ({ tenantId, tokenHash }) => tenantId === scope.tenantId && tokenHash.equals(digest("a".repeat(64))) ? account : null,
      findAccount: async () => account, limit: async () => true,
      addresses: async () => [{ id: addressId, contactName: "Test", phone: "+919876543210", line1: "123 Test Road", line2: "", landmark: "", city: "Bengaluru", stateCode: "KA", postalCode: "560001" }] },
    cartDao: { read: async () => structuredClone(cart), save: async ({ items }) => { cart.items = items; cart.revision++; } },
    offers: async () => [product],
    orderDao: { findOffersForOrder: async () => [{ id: offerId }] },
    dao: { previousAddresses: async () => [], slots: async () => slot.closed ? [] : [{ ...slot }], couponPromotion: async () => null,
      insertQuote: async ({ quoteId, quote, revision, customerId: owner }) => rows.set(quoteId, { quote: structuredClone(quote), revision, owner, expiresAt: "2099-01-01T00:00:00Z" }),
      readQuote: async ({ quoteId, customerId: owner }) => rows.get(quoteId)?.owner === owner ? rows.get(quoteId) : null,
      complete: async ({ quoteId, receipt }) => { rows.get(quoteId).receipt = receipt; } },
    orderFactory: ({ dao }) => ({ createOrder: async (_tenant, data, context) => {
      const [offer] = await dao.findOffersForOrder({});
      const review = { grandTotal: offer.salePrice + slot.deliveryFee, currency: "INR", items: [{ offerId, quantity: data.items[0].quantity }] };
      if (context.preview) return review;
      context.verifyReview(review); counts.orders++;
      return { order: { id: createId(), orderNumber: "WEB-TEST", grandTotal: review.grandTotal, currency: "INR" } };
    } }) });
  return { service, scope, input, token: "a".repeat(64), cart, product, slot, rows, counts };
}
test("checkout requires customer authentication and rejects client pricing or identity fields", async () => {
  const s = setup();
  await assert.rejects(s.service.options(s.scope, "admin-token", {}), { status: 401 });
  await assert.rejects(s.service.options({ ...s.scope, tenantId: createId() }, s.token, {}), { status: 401 });
  assert.throws(() => validate(checkoutSchemas.quote, { ...s.input, grandTotal: 1 }), { status: 422 });
  assert.throws(() => validate(checkoutSchemas.place, { quoteId: createId(), customerId: createId() }), { status: 422 });
});
test("review does not create an order; retry returns one receipt and clears only the purchased cart", async () => {
  const s = setup(); const q = await s.service.quote(s.scope, s.token, s.input);
  assert.equal(s.counts.orders, 0);
  const placed = await s.service.place(s.scope, s.token, { quoteId: q.quoteId });
  s.cart.items = [{ offerId: createId(), quantity: 1 }];
  const retry = await s.service.place(s.scope, s.token, { quoteId: q.quoteId });
  assert.deepEqual(retry, placed); assert.equal(s.counts.orders, 1); assert.equal(s.cart.items.length, 1);
  assert.equal(placed.receipt.paymentStatus, "UNPAID");
});
test("stale cart, expired quotes, changed prices and changed delivery slots require a new review", async () => {
  for (const mutate of [(s) => s.cart.revision++, (s, q) => { s.rows.get(q.quoteId).expired = true; }, (s) => s.product.price++, (s) => { s.slot.closed = true; }]) {
    const s = setup(); const q = await s.service.quote(s.scope, s.token, s.input); mutate(s, q);
    await assert.rejects(s.service.place(s.scope, s.token, { quoteId: q.quoteId }), { status: 409 });
    assert.equal(s.counts.orders, 0); assert.equal(s.cart.items.length, 1);
  }
});
test("foreign addresses, unknown checkout attempts, invalid coupons and shortages are rejected", async () => {
  const s = setup();
  await assert.rejects(s.service.quote(s.scope, s.token, { ...s.input, addressId: createId() }), { status: 404 });
  await assert.rejects(s.service.read(s.scope, s.token, { quoteId: createId() }), { status: 404 });
  await assert.rejects(s.service.quote(s.scope, s.token, { ...s.input, couponCode: "INVALID" }), { status: 422 });
  s.product.availableQuantity = 0;
  await assert.rejects(s.service.quote(s.scope, s.token, s.input), { status: 409 });
});

test("checkout options include the customer's saved and previous addresses", async () => {
  const s = setup();
  const data = await s.service.options(s.scope, s.token, {});
  assert.equal(data.addresses[0].id, s.input.addressId);
  assert.deepEqual(data.previousAddresses, []);
  assert.equal(data.deliveryAvailability, null);
  const selected = await s.service.options(s.scope, s.token, { addressId: s.input.addressId });
  assert.equal(selected.deliveryAvailability.postalCode, "560001");
  await assert.rejects(s.service.options(s.scope, s.token, { addressId: createId() }), { status: 404 });
});

test("previous addresses are scoped, deduplicated, normalized and projected without private order data", async () => {
  const scope = { tenantId: createId(), storeId: createId(), customerId: createId() };
  const home = { contactName: 'Test Customer', phone: '+91 9876543210', line1: '1 Home Road', line2: '', landmark: '', city: 'Bengaluru', stateCode: 'KA', stateName: 'Karnataka', postalCode: '560001' };
  const work = { ...home, line1: '2 Work Road', stateCode: '29', phone: undefined, secret: 'DO_NOT_EXPOSE' };
  const makeRow = (shipping) => ({ id: uuidToBuffer(createId()), order_number: 'TEST-ORDER', shipping_address_snapshot: JSON.stringify(shipping),
    customer_snapshot: JSON.stringify({ name: 'Test Customer', phone: '9876543210', email: 'DO_NOT_EXPOSE' }), internal_notes: 'DO_NOT_EXPOSE' });
  const rows = [makeRow(home), makeRow(work), makeRow({ ...work, line1: ' 2 Work Road ' }), makeRow({ ...home, countryCode: 'US' }), { shipping_address_snapshot: 'invalid' }];
  const connection = { execute: async (sql, bindings) => {
    assert.match(sql, /tenant_id = \? AND store_id = \? AND customer_id = \? AND status <> 'DRAFT'/);
    assert.match(sql, /LIMIT 50/);
    assert.deepEqual(bindings, [scope.tenantId, scope.storeId, scope.customerId].map(uuidToBuffer));
    return [rows];
  } };
  const result = await previousAddresses({ ...scope, savedAddresses: [home], connection });
  assert.equal(result.length, 1); assert.equal(result[0].line1, '2 Work Road');
  assert.equal(result[0].stateCode, 'KA'); assert.equal(result[0].phone, '9876543210');
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE/);
});
