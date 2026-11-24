import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createId, uuidToBuffer } from "../src/core/identifiers/uuid.js";
import { createStorefrontService } from "../src/modules/storefront/storefront.service.js";
import { expectedDate, describeDeliveryAvailability } from "../src/modules/storefront/delivery-availability.service.js";
import { deliveryAvailability } from "../src/modules/storefront/delivery-availability.dao.js";

test("calendar estimates cross IST midnight and include seller preparation", () => {
  assert.equal(expectedDate(3,25,new Date("2026-11-24T18:30:00Z")), "2026-11-30");
  assert.equal(describeDeliveryAvailability(null,"560001").available,false);
  assert.equal(describeDeliveryAvailability({deliveryDays:3,deliveryFee:39},"560001").available,true);
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

test("coverage is scoped, independent of schedules and unambiguous", async () => {
  const scope={tenantId:createId(),storeId:createId(),postalCode:"560001"};
  let rows=[{exactPin:1,deliveryDays:3},{exactPin:0,deliveryDays:5}];
  const connection={execute:async(sql,bindings)=>{
    assert.deepEqual(bindings,[scope.postalCode,uuidToBuffer(scope.tenantId),uuidToBuffer(scope.storeId)]);
    assert.doesNotMatch(sql,/delivery_slot/); return [rows];
  }};
  assert.equal((await deliveryAvailability({...scope,connection})).deliveryDays,3);
  rows=[{exactPin:1},{exactPin:1}];assert.equal(await deliveryAvailability({...scope,connection}),null);
});
