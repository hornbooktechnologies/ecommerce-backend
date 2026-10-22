import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./bundles.dao.js";

function fail(code, message, status = 422) { throw new AppError({ code, message, status, details: [] }); }
export function createBundlesService({ dao = defaultDao, transaction = withTransaction } = {}) {
  async function listVariants(tenantId, input) { const result = await dao.listVariantOptions({ tenantId, ...input });
    return { ...result, page: input.page, pageSize: input.pageSize, totalPages: Math.max(1, Math.ceil(result.total / input.pageSize)) }; }
  async function listBundles(tenantId, input) { const result = await dao.listBundles({ tenantId, ...input });
    return { ...result, page: input.page, pageSize: input.pageSize, totalPages: Math.max(1, Math.ceil(result.total / input.pageSize)) }; }
  async function assertBundle(tenantId, bundleVariantId, connection) {
    const bundle = await dao.findVariant({ tenantId, variantId: bundleVariantId, connection });
    if (!bundle || bundle.productKind !== "BUNDLE") fail("BUNDLE_VARIANT_NOT_FOUND", "Select a variant from an active bundle product.", 404);
    if (bundle.status !== "ACTIVE") fail("ACTIVE_BUNDLE_REQUIRED", "The bundle variant must be active.", 409);
    return bundle;
  }
  async function createComponent(tenantId, bundleVariantId, input, context) {
    const id = createId();
    try { await transaction(tenantId, async (connection) => {
      const [bundle, component] = await Promise.all([assertBundle(tenantId, bundleVariantId, connection),
        dao.findVariant({ tenantId, variantId: input.componentVariantId, connection })]);
      if (!component || component.status !== "ACTIVE") fail("COMPONENT_VARIANT_NOT_FOUND", "Select an active component SKU.", 404);
      if (bundle.id === component.id) fail("BUNDLE_SELF_REFERENCE", "A bundle cannot contain itself.");
      if (await dao.wouldCreateCycle({ tenantId, bundleVariantId, componentVariantId: component.id, connection }))
        fail("BUNDLE_CYCLE_DETECTED", "This component would create a circular bundle relationship.", 409);
      const sortOrder = input.sortOrder ?? await dao.nextSortOrder({ tenantId, bundleVariantId, connection });
      await dao.insertComponent({ component: { id, tenantId, bundleVariantId, ...input, sortOrder }, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "catalog.bundle.component.created", entityId: bundleVariantId, requestId: context.requestId,
        ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null,
        afterData: { componentId: id, componentVariantId: component.id, componentSku: component.sku,
          quantity: input.quantity, isOptional: input.isOptional, sortOrder } }, connection });
    }); } catch (error) { if (error?.code === "ER_DUP_ENTRY") fail("BUNDLE_COMPONENT_EXISTS", "This SKU is already part of the bundle.", 409); throw error; }
    return { id, bundleVariantId, ...input };
  }
  async function updateComponent(tenantId, bundleVariantId, componentId, input, context) {
    await transaction(tenantId, async (connection) => { await assertBundle(tenantId, bundleVariantId, connection);
      const current = await dao.findComponent({ tenantId, bundleVariantId, componentId, connection });
      if (!current) fail("BUNDLE_COMPONENT_NOT_FOUND", "The bundle component could not be found.", 404);
      await dao.updateComponent({ componentId, input, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "catalog.bundle.component.updated", entityId: bundleVariantId, requestId: context.requestId,
        ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null,
        afterData: { componentId, ...input } }, connection }); });
    return { id: componentId, ...input };
  }
  async function deleteComponent(tenantId, bundleVariantId, componentId, context) {
    await transaction(tenantId, async (connection) => { await assertBundle(tenantId, bundleVariantId, connection);
      const current = await dao.findComponent({ tenantId, bundleVariantId, componentId, connection });
      if (!current) fail("BUNDLE_COMPONENT_NOT_FOUND", "The bundle component could not be found.", 404);
      await dao.deleteComponent({ componentId, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "catalog.bundle.component.deleted", entityId: bundleVariantId, requestId: context.requestId,
        ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null, afterData: current }, connection }); });
  }
  return { listVariants, listBundles, createComponent, updateComponent, deleteComponent };
}
const service = createBundlesService();
export const listVariants = service.listVariants; export const listBundles = service.listBundles;
export const createComponent = service.createComponent; export const updateComponent = service.updateComponent;
export const deleteComponent = service.deleteComponent;
