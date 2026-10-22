import assert from "node:assert/strict";
import test from "node:test";
import { createSubstitutionsService } from "../src/modules/substitutions/substitutions.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const sourceId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const targetId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const context = { actorUserId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77", requestId: "sub-test" };
function make({ source = {}, target = {}, calls = {} } = {}) {
  const dao = {
    async findVariant({ variantId }) { return variantId === sourceId
      ? { id: sourceId, sku: "MILK-1L", vertical: "GROCERY", status: "ACTIVE", allowSubstitutions: true, ...source }
      : { id: targetId, sku: "MILK-ALT", vertical: "GROCERY", status: "ACTIVE", allowSubstitutions: true, ...target }; },
    async insertRule({ rule }) { calls.rule = rule; }, async insertAudit() { calls.audit = true; }
  };
  return createSubstitutionsService({ dao, transaction: async (_tenantId, work) => work({}) });
}

test("creates an audited grocery substitution rule", async () => {
  const calls = {}; const service = make({ calls });
  const result = await service.createRule(tenantId, { sourceVariantId: sourceId, substituteVariantId: targetId,
    priority: 1, maximumPriceDifferencePercent: 10, status: "ACTIVE" }, context);
  assert.equal(result.sourceVariantId, sourceId); assert.equal(calls.rule.tenantId, tenantId); assert.equal(calls.audit, true);
});

test("rejects self substitution", async () => {
  await assert.rejects(() => make().createRule(tenantId, { sourceVariantId: sourceId, substituteVariantId: sourceId,
    priority: 1, maximumPriceDifferencePercent: null, status: "ACTIVE" }, context),
  (error) => error.code === "SUBSTITUTE_MATCHES_SOURCE");
});

test("source products must explicitly allow substitutions", async () => {
  await assert.rejects(() => make({ source: { allowSubstitutions: false } }).createRule(tenantId,
    { sourceVariantId: sourceId, substituteVariantId: targetId, priority: 1,
      maximumPriceDifferencePercent: null, status: "ACTIVE" }, context),
  (error) => error.code === "SUBSTITUTIONS_NOT_ENABLED" && error.status === 409);
});
