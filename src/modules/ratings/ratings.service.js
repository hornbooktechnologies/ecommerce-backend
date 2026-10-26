import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./ratings.dao.js";

const missing = () => new AppError({ code: "PRODUCT_RATING_NOT_FOUND",
  message: "The product rating was not found.", status: 404 });

export function createRatingsService({ dao = defaultDao, transaction = withTransaction } = {}) {
  const listRatings = (tenantId, filters) => dao.listRatings({ tenantId, filters });
  const listOptions = (tenantId) => dao.listOptions({ tenantId });
  async function getRating(tenantId, ratingId) {
    const rating = await dao.getRating({ tenantId, ratingId }); if (!rating) throw missing(); return rating;
  }
  async function moderateRating(tenantId, ratingId, input, context) {
    await transaction(tenantId, async (connection) => {
      const current = await dao.getRating({ tenantId, ratingId, connection, forUpdate: true });
      if (!current) throw missing();
      await dao.updateRatingStatus({ ratingId, status: input.status, notes: input.notes,
        actorUserId: context.actorUserId, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: `PRODUCT_RATING_${input.status}`, entityId: ratingId, requestId: context.requestId,
        ipAddress: context.ipAddress || "127.0.0.1", userAgent: context.userAgent,
        beforeData: { status: current.status, moderationNotes: current.moderationNotes },
        afterData: { status: input.status, moderationNotes: input.notes } }, connection });
    });
    return getRating(tenantId, ratingId);
  }
  return { listRatings, listOptions, getRating, moderateRating };
}

const service = createRatingsService();
export const { listRatings, listOptions, getRating, moderateRating } = service;
