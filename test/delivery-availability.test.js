import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createId, uuidToBuffer } from "../src/core/identifiers/uuid.js";
import { createStorefrontService } from "../src/modules/storefront/storefront.service.js";
import { describeDeliveryAvailability } from "../src/modules/storefront/delivery-availability.service.js";
import { deliveryAvailability } from "../src/modules/storefront/delivery-availability.dao.js";

test("delivery status distinguishes unsupported, unscheduled, closed and full from bookable", () => {
  const scenarios = [
    [{ zones: 0 }, "UNSUPPORTED"], [{ zones: 1, scheduled: 0 }, "NOT_SCHEDULED"],
    [{ zones: 1, scheduled: 3, bookable: 0 }, "BOOKING_CLOSED"],
    [{ zones: 1, scheduled: 3, bookable: 2, available: 0 }, "FULL"],
    [{ zones: 2, scheduled: 3, bookable: 2, available: 1, next_start: "2030-01-01T00:00:00Z" }, "AVAILABLE"]
  ];
  for (const [row, status] of scenarios) {
    const result = describeDeliveryAvailability(row, "560001");
    assert.equal(result.status, status); assert.equal(result.available, status === "AVAILABLE");
    assert.equal(result.covered, status !== "UNSUPPORTED");
    assert.equal(result.postalCode, "560001"); assert.ok(result.message.length);
    assert.deepEqual(Object.keys(result).sort(), ["postalCode", "status", "covered", "available", "message", "nextStartsAt"].sort());
  }
});

test("public delivery endpoint validates PIN and resolves the active store before querying", async () => {
  const scope = { tenantId: createId(), storeId: createId() };
  let calls = 0;
  const service = createStorefrontService({ dao: { resolveStore: async ({ tenantCode, storeCode }) => tenantCode === "SHOP" && storeCode === "MAIN" ? scope : null },
    delivery: async (input) => { calls++; assert.deepEqual(input, { ...scope, postalCode: "560001" }); return { available: true }; } });
  const app = createApp({ storefrontService: service });
  const path = "/api/storefront/v1/SHOP/stores/MAIN/delivery-availability";
  const result = await request(app).get(`${path}?postalCode=560001`).set("x-tenant-id", createId());
  assert.equal(result.status, 200); assert.equal(result.headers["cache-control"], "no-store");
  for (const query of ["", "postalCode=123", "postalCode=000001", "postalCode=ABCDEF", "postalCode=560001&storeId=OTHER", "postalCode=560001&postalCode=560002"]) {
    assert.equal((await request(app).get(`${path}?${query}`)).status, 422);
  }
  assert.equal((await request(app).get("/api/storefront/v1/OTHER/stores/MAIN/delivery-availability?postalCode=560001")).status, 404);
  assert.equal(calls, 1);
});

test("delivery DAO binds tenant/store/PIN and uses active rules, UTC cutoff and both capacities", async () => {
  const scope = { tenantId: createId(), storeId: createId(), postalCode: "560001" };
  const connection = { execute: async (sql, bindings) => {
    assert.deepEqual(bindings, [uuidToBuffer(scope.tenantId), uuidToBuffer(scope.storeId), scope.postalCode]);
    for (const text of ["z.tenant_id = ? AND z.store_id = ?", "t.status = 'ACTIVE'", "z.status = 'ACTIVE'", "p.status = 'ACTIVE'", "INTERVAL t.cutoff_minutes MINUTE", "INTERVAL 30 DAY", "s.reserved_orders < s.order_capacity", "s.reserved_weight < s.weight_capacity"]) assert.ok(sql.includes(text));
    return [[{ zones: 1, available: 2 }]];
  } };
  assert.equal((await deliveryAvailability({ ...scope, connection })).available, 2);
});
