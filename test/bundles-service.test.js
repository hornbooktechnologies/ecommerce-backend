import assert from "node:assert/strict";
import test from "node:test";
import { createBundlesService } from "../src/modules/bundles/bundles.service.js";
const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88"; const bundleId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const componentId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55"; const context = { actorUserId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77", requestId: "bundle-test" };
function make({ cycle = false, bundle = {}, component = {}, calls = {} } = {}) { const dao = {
  async findVariant({ variantId }) { return variantId === bundleId ? { id: bundleId, sku: "KIT-1", productKind: "BUNDLE", status: "ACTIVE", ...bundle }
    : { id: componentId, sku: "ITEM-1", productKind: "STANDARD", status: "ACTIVE", ...component }; },
  async wouldCreateCycle() { return cycle; }, async nextSortOrder() { return 2; },
  async insertComponent({ component: value }) { calls.component = value; }, async insertAudit() { calls.audit = true; } };
  return createBundlesService({ dao, transaction: async (_tenantId, work) => work({}) }); }
test("adds an audited component with the next display order", async () => { const calls = {}; const result = await make({ calls }).createComponent(tenantId, bundleId,
  { componentVariantId: componentId, quantity: 2, isOptional: false, sortOrder: null }, context);
  assert.equal(result.bundleVariantId, bundleId); assert.equal(calls.component.sortOrder, 2); assert.equal(calls.audit, true); });
test("rejects a relationship that creates a bundle cycle", async () => { await assert.rejects(() => make({ cycle: true }).createComponent(tenantId, bundleId,
  { componentVariantId: componentId, quantity: 1, isOptional: false, sortOrder: null }, context), (error) => error.code === "BUNDLE_CYCLE_DETECTED" && error.status === 409); });
test("only bundle products can receive components", async () => { await assert.rejects(() => make({ bundle: { productKind: "STANDARD" } }).createComponent(tenantId, bundleId,
  { componentVariantId: componentId, quantity: 1, isOptional: false, sortOrder: null }, context), (error) => error.code === "BUNDLE_VARIANT_NOT_FOUND"); });
