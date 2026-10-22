import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./substitutions.dao.js";

function fail(code, message, status = 422, details = []) { throw new AppError({ code, message, status, details }); }

export function createSubstitutionsService({ dao = defaultDao, transaction = withTransaction } = {}) {
  async function validatePair(tenantId, input, connection) {
    if (input.sourceVariantId === input.substituteVariantId) fail("SUBSTITUTE_MATCHES_SOURCE", "Choose a different substitute SKU.");
    const [source, substitute] = await Promise.all([
      dao.findVariant({ tenantId, variantId: input.sourceVariantId, connection }),
      dao.findVariant({ tenantId, variantId: input.substituteVariantId, connection })
    ]);
    if (!source || !substitute) fail("GROCERY_VARIANT_NOT_FOUND", "One or more selected grocery SKUs could not be found.", 404);
    if (source.vertical !== "GROCERY" || substitute.vertical !== "GROCERY") fail("GROCERY_VARIANT_REQUIRED", "Substitution rules can only connect grocery SKUs.");
    if (source.status !== "ACTIVE" || substitute.status !== "ACTIVE") fail("ACTIVE_VARIANT_REQUIRED", "Both grocery SKUs must be active.");
    if (!source.allowSubstitutions) fail("SUBSTITUTIONS_NOT_ENABLED", "Enable substitutions on the source product before creating a rule.", 409);
    return { source, substitute };
  }

  async function listVariants(tenantId, input) {
    const result = await dao.listVariants({ tenantId, ...input });
    return { ...result, page: input.page, pageSize: input.pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / input.pageSize)) };
  }

  async function listRules(tenantId, input) {
    const result = await dao.listRules({ tenantId, ...input });
    return { ...result, page: input.page, pageSize: input.pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / input.pageSize)) };
  }

  async function createRule(tenantId, input, context) {
    const id = createId();
    try {
      await transaction(tenantId, async (connection) => {
        const pair = await validatePair(tenantId, input, connection);
        await dao.insertRule({ rule: { id, tenantId, ...input }, connection });
        await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
          action: "catalog.substitution.created", entityId: id, requestId: context.requestId,
          ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null,
          afterData: { ...input, sourceSku: pair.source.sku, substituteSku: pair.substitute.sku } }, connection });
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") fail("SUBSTITUTION_RULE_EXISTS", "This substitute is already assigned to the source SKU.", 409);
      throw error;
    }
    return { id, ...input };
  }

  async function updateRule(tenantId, ruleId, input, context) {
    await transaction(tenantId, async (connection) => {
      const rule = await dao.findRule({ tenantId, ruleId, connection });
      if (!rule) fail("SUBSTITUTION_RULE_NOT_FOUND", "The substitution rule could not be found.", 404);
      await dao.updateRule({ ruleId, input, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "catalog.substitution.updated", entityId: ruleId, requestId: context.requestId,
        ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null,
        afterData: input }, connection });
    });
    return { id: ruleId, ...input };
  }

  async function deleteRule(tenantId, ruleId, context) {
    await transaction(tenantId, async (connection) => {
      const rule = await dao.findRule({ tenantId, ruleId, connection });
      if (!rule) fail("SUBSTITUTION_RULE_NOT_FOUND", "The substitution rule could not be found.", 404);
      await dao.deleteRule({ ruleId, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "catalog.substitution.deleted", entityId: ruleId, requestId: context.requestId,
        ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null,
        afterData: rule }, connection });
    });
  }
  return { listVariants, listRules, createRule, updateRule, deleteRule };
}

const service = createSubstitutionsService();
export const listVariants = service.listVariants;
export const listRules = service.listRules;
export const createRule = service.createRule;
export const updateRule = service.updateRule;
export const deleteRule = service.deleteRule;
