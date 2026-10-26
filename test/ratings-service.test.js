import assert from "node:assert/strict";
import test from "node:test";
import { createRatingsService } from "../src/modules/ratings/ratings.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const ratingId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const actor = { actorUserId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77", requestId: "rating-test",
  ipAddress: "127.0.0.1", userAgent: "test" };
const transaction = async (_tenantId, operation) => operation({});

test("rating moderation is tenant-scoped, transactional and audited", async () => {
  let updated; let audit;
  const dao = { async getRating({ forUpdate }) { return forUpdate
    ? { id: ratingId, status: "PENDING", moderationNotes: "" }
    : { id: ratingId, status: "PUBLISHED", moderationNotes: "Meets review policy" }; },
  async updateRatingStatus(input) { updated = input; return true; },
  async insertAudit(input) { audit = input.audit; } };
  const service = createRatingsService({ dao, transaction });
  const result = await service.moderateRating(tenantId, ratingId,
    { status: "PUBLISHED", notes: "Meets review policy" }, actor);
  assert.equal(updated.status, "PUBLISHED"); assert.equal(updated.actorUserId, actor.actorUserId);
  assert.equal(audit.action, "PRODUCT_RATING_PUBLISHED"); assert.equal(audit.beforeData.status, "PENDING");
  assert.equal(result.status, "PUBLISHED");
});

test("missing product ratings return a domain 404", async () => {
  const service = createRatingsService({ dao: { async getRating() { return null; } }, transaction });
  await assert.rejects(() => service.getRating(tenantId, ratingId),
    (error) => error.code === "PRODUCT_RATING_NOT_FOUND" && error.status === 404);
});
