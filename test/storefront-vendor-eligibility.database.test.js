import test from "node:test";
import assert from "node:assert/strict";
import { getPrimaryPool, closePrimaryPool } from "../src/database/pool-factory.js";
import { createId, uuidToBuffer as id, bufferToUuid as uuid } from "../src/core/identifiers/uuid.js";
import { resolveStore, listVariants, cartOffers } from "../src/modules/storefront/storefront.dao.js";

// Opt-in integration test against the local demo database. Every change is rolled back.
test("storefront requires active, approved vendors for product and cart offers", {
  skip: process.env.STOREFRONT_VENDOR_DB_TESTS !== "true"
}, async () => {
  const connection = await getPrimaryPool().getConnection();
  try {
    await connection.beginTransaction();
    const scope = await resolveStore({ tenantCode: "HORNBOOK_RETAIL", storeCode: "MAIN", connection });
    assert.ok(scope, "Hornbook MAIN fixture store required");
    const [candidates] = await connection.execute(`SELECT so.id AS offer_id, so.merchant_id,
      pv.product_id, m.merchant_type FROM seller_offers so
      JOIN merchants m ON m.id = so.merchant_id AND m.tenant_id = so.tenant_id
      JOIN product_variants pv ON pv.id = so.variant_id AND pv.tenant_id = so.tenant_id
      JOIN stores s ON s.id = so.store_id AND s.tenant_id = so.tenant_id
      JOIN tenants t ON t.id = so.tenant_id
      WHERE t.code = 'HORNBOOK_RETAIL' AND s.code = 'MAIN'
        AND so.status = 'ACTIVE' AND so.deleted_at IS NULL AND m.status = 'ACTIVE'
        AND m.merchant_type = 'FIRST_PARTY'`);
    const fixtures = {};
    for (const candidate of candidates) {
      if (fixtures[candidate.merchant_type]) continue;
      const offers = await listVariants({ scope, productId: uuid(candidate.product_id), connection });
      if (offers.some(offer => offer.offerId === uuid(candidate.offer_id))) fixtures[candidate.merchant_type] = candidate;
      if (fixtures.FIRST_PARTY) break;
    }
    assert.ok(fixtures.FIRST_PARTY, "An eligible first-party control offer is required");
    // Create a temporary vendor offer using an eligible product/price as a control.
    // No pre-existing eligible vendor listing is required to reproduce the regression.
    const vendorId = createId(), offerId = createId();
    await connection.execute(`INSERT INTO merchants
      (id, tenant_id, merchant_code, merchant_type, display_name, status)
      VALUES (?, ?, ?, 'VENDOR', 'Eligibility regression vendor', 'ACTIVE')`,
    [id(vendorId), id(scope.tenantId), vendorId]);
    await connection.execute(`INSERT INTO vendor_profiles (merchant_id, tenant_id, onboarding_status)
      VALUES (?, ?, 'APPROVED')`, [id(vendorId), id(scope.tenantId)]);
    await connection.execute(`INSERT INTO store_merchants (store_id, merchant_id, status)
      VALUES (?, ?, 'ACTIVE')`, [id(scope.storeId), id(vendorId)]);
    await connection.execute(`INSERT INTO seller_offers (id, tenant_id, store_id, merchant_id, variant_id, seller_sku, status)
      SELECT ?, tenant_id, store_id, ?, variant_id, ?, 'ACTIVE' FROM seller_offers WHERE id = ?`,
    [id(offerId), id(vendorId), offerId, fixtures.FIRST_PARTY.offer_id]);
    const [prices] = await connection.execute(`SELECT * FROM offer_prices WHERE offer_id = ?`, [fixtures.FIRST_PARTY.offer_id]);
    for (const price of prices) {
      await connection.execute(`INSERT INTO offer_prices
        (id, tenant_id, offer_id, price_list_id, list_price, sale_price, cost_price, starts_at, ends_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id(createId()), id(scope.tenantId), id(offerId), price.price_list_id, price.list_price,
        price.sale_price, price.cost_price, price.starts_at, price.ends_at]);
    }
    const vendor = { offer_id: id(offerId), merchant_id: id(vendorId), product_id: fixtures.FIRST_PARTY.product_id };
    async function checkVisible(fixture, expected, label, queryScope = scope) {
      const offerId = uuid(fixture.offer_id);
      const variants = await listVariants({ scope: queryScope, productId: uuid(fixture.product_id), connection });
      const cart = await cartOffers({ scope: queryScope, offerIds: [offerId], connection });
      assert.equal(variants.some(offer => offer.offerId === offerId), expected, `${label}: product variants`);
      assert.equal(cart.some(offer => offer.offerId === offerId), expected, `${label}: cart offers`);
    }
    for (const [merchantStatus, onboardingStatus, expected] of [
      ["ACTIVE", "APPROVED", true],
      ["PENDING", "APPROVED", false],
      ["SUSPENDED", "APPROVED", false],
      ["ACTIVE", "SUBMITTED", false],
      ["ACTIVE", "SUSPENDED", false],
      ["ACTIVE", "APPROVED", true]
    ]) {
      await connection.execute("UPDATE merchants SET status = ? WHERE id = ?", [merchantStatus, vendor.merchant_id]);
      await connection.execute("UPDATE vendor_profiles SET onboarding_status = ? WHERE merchant_id = ?", [onboardingStatus, vendor.merchant_id]);
      await checkVisible(vendor, expected, `${merchantStatus}/${onboardingStatus}`);
      await checkVisible(fixtures.FIRST_PARTY, true, "First-party offer unaffected");
    }
    await connection.execute("UPDATE seller_offers SET status = 'INACTIVE' WHERE id = ?", [vendor.offer_id]);
    await checkVisible(vendor, false, "Inactive seller offer");
    await connection.execute("UPDATE seller_offers SET status = 'ACTIVE' WHERE id = ?", [vendor.offer_id]);
    await checkVisible(vendor, false, "Different tenant", { ...scope, tenantId: createId() });
    await connection.execute("DELETE FROM vendor_profiles WHERE merchant_id = ?", [vendor.merchant_id]);
    await checkVisible(vendor, false, "Missing vendor approval profile");
  } finally {
    await connection.rollback();
    connection.release();
    await closePrimaryPool();
  }
});
