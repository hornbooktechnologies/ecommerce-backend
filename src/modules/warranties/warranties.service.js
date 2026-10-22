import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./warranties.dao.js";

function fail(code, message, status = 422, field = null) {
  throw new AppError({ code, message, status,
    details: field ? [{ field, code: code.toLowerCase(), message }] : [] });
}

function documentNumber(id) {
  return `WCL-${id.replaceAll("-", "").slice(-12).toUpperCase()}`;
}

export function createWarrantiesService({ dao = defaultDao, transaction = withTransaction } = {}) {
  const requireClaim = async (tenantId, claimId, connection, forUpdate = false) => {
    const result = await dao.getClaim({ tenantId, claimId, connection, forUpdate });
    if (!result) fail("WARRANTY_CLAIM_NOT_FOUND", "Warranty claim was not found.", 404);
    return result;
  };

  async function record({ tenantId, claimId, type, previousStatus, newStatus, notes, metadata,
    action, context, connection }) {
    await dao.insertClaimEvent({ event: { id: createId(), tenantId, claimId, type,
      previousStatus, newStatus, notes, metadata, createdBy: context.actorUserId }, connection });
    await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
      action, entityId: claimId, requestId: context.requestId, ipAddress: context.ipAddress,
      userAgent: context.userAgent, beforeData: { status: previousStatus },
      afterData: { status: newStatus, ...metadata } }, connection });
  }

  async function listWarrantyOptions(tenantId) { return dao.listWarrantyOptions({ tenantId }); }
  async function listWarranties(tenantId, filters) { return dao.listWarranties({ tenantId, filters }); }
  async function listClaims(tenantId, filters) { return dao.listClaims({ tenantId, filters }); }

  async function getWarranty(tenantId, warrantyId) {
    const result = await dao.getWarranty({ tenantId, warrantyId });
    if (!result) fail("WARRANTY_NOT_FOUND", "Warranty registration was not found.", 404);
    return result;
  }

  async function getClaim(tenantId, claimId) { return requireClaim(tenantId, claimId); }

  async function createClaim(tenantId, input, context) {
    return transaction(tenantId, async (connection) => {
      const warranty = await dao.findWarrantyForClaim({ tenantId,
        warrantyId: input.warrantyRegistrationId, connection });
      if (!warranty) fail("WARRANTY_NOT_FOUND", "Warranty registration was not found.", 404);
      if (warranty.status !== "ACTIVE") {
        fail("WARRANTY_NOT_ACTIVE", warranty.status === "EXPIRED"
          ? `This warranty expired on ${warranty.endsAt}.` : "This warranty is not active.", 409);
      }
      if (!warranty.serialId || warranty.serialStatus !== "SOLD") {
        fail("WARRANTY_SERIAL_INELIGIBLE", "The serial number was returned, replaced, or is no longer eligible.", 409);
      }
      if (warranty.hasOpenClaim) {
        fail("WARRANTY_CLAIM_ALREADY_OPEN", "An active claim already exists for this warranty.", 409);
      }
      const id = createId();
      const number = documentNumber(id);
      await dao.insertClaim({ claim: { id, tenantId, warrantyId: warranty.id, number,
        issueDescription: input.issueDescription, openedBy: context.actorUserId }, connection });
      await record({ tenantId, claimId: id, type: "CLAIM_OPENED", previousStatus: null,
        newStatus: "OPEN", notes: input.issueDescription, metadata: { warrantyId: warranty.id },
        action: "warranty.claim.opened", context, connection });
      return dao.getClaim({ tenantId, claimId: id, connection });
    });
  }

  async function assignClaim(tenantId, claimId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await requireClaim(tenantId, claimId, connection, true);
      if (!["OPEN", "ASSIGNED", "DIAGNOSED"].includes(current.claim.status)) {
        fail("WARRANTY_CLAIM_STATUS_INVALID", "Resolved or closed claims cannot be reassigned.", 409);
      }
      if (!(await dao.findAssignableUser({ tenantId, userId: input.assignedTo, connection }))) {
        fail("WARRANTY_ASSIGNEE_INVALID", "Select an active team member from this tenant.", 422, "assignedTo");
      }
      const nextStatus = current.claim.status === "OPEN" ? "ASSIGNED" : current.claim.status;
      await dao.assignClaim({ tenantId, claimId, assignedTo: input.assignedTo, connection });
      await record({ tenantId, claimId, type: "CLAIM_ASSIGNED", previousStatus: current.claim.status,
        newStatus: nextStatus, notes: input.notes, metadata: { assignedTo: input.assignedTo },
        action: "warranty.claim.assigned", context, connection });
      return dao.getClaim({ tenantId, claimId, connection });
    });
  }

  async function diagnoseClaim(tenantId, claimId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await requireClaim(tenantId, claimId, connection, true);
      if (!["OPEN", "ASSIGNED"].includes(current.claim.status)) {
        fail("WARRANTY_CLAIM_STATUS_INVALID", "Only open or assigned claims can be diagnosed.", 409);
      }
      await dao.diagnoseClaim({ tenantId, claimId, diagnosisNotes: input.diagnosisNotes,
        assignedTo: context.actorUserId, connection });
      await record({ tenantId, claimId, type: "CLAIM_DIAGNOSED", previousStatus: current.claim.status,
        newStatus: "DIAGNOSED", notes: input.diagnosisNotes, metadata: null,
        action: "warranty.claim.diagnosed", context, connection });
      return dao.getClaim({ tenantId, claimId, connection });
    });
  }

  async function resolveClaim(tenantId, claimId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await requireClaim(tenantId, claimId, connection, true);
      if (current.claim.status !== "DIAGNOSED") {
        fail("WARRANTY_CLAIM_STATUS_INVALID", "Diagnose the claim before recording a resolution.", 409);
      }
      await dao.resolveClaim({ tenantId, claimId, resolutionType: input.resolutionType,
        resolutionNotes: input.resolutionNotes, connection });
      await record({ tenantId, claimId, type: "CLAIM_RESOLVED", previousStatus: "DIAGNOSED",
        newStatus: "RESOLVED", notes: input.resolutionNotes,
        metadata: { resolutionType: input.resolutionType }, action: "warranty.claim.resolved", context, connection });
      return dao.getClaim({ tenantId, claimId, connection });
    });
  }

  async function closeClaim(tenantId, claimId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await requireClaim(tenantId, claimId, connection, true);
      if (current.claim.status !== "RESOLVED") {
        fail("WARRANTY_CLAIM_STATUS_INVALID", "Resolve the claim before closing it.", 409);
      }
      await dao.closeClaim({ tenantId, claimId, connection });
      await record({ tenantId, claimId, type: "CLAIM_CLOSED", previousStatus: "RESOLVED",
        newStatus: "CLOSED", notes: input.notes, metadata: null,
        action: "warranty.claim.closed", context, connection });
      return dao.getClaim({ tenantId, claimId, connection });
    });
  }

  return { listWarrantyOptions, listWarranties, getWarranty, listClaims, getClaim,
    createClaim, assignClaim, diagnoseClaim, resolveClaim, closeClaim };
}

const service = createWarrantiesService();
export const listWarrantyOptions = service.listWarrantyOptions;
export const listWarranties = service.listWarranties;
export const getWarranty = service.getWarranty;
export const listClaims = service.listClaims;
export const getClaim = service.getClaim;
export const createClaim = service.createClaim;
export const assignClaim = service.assignClaim;
export const diagnoseClaim = service.diagnoseClaim;
export const resolveClaim = service.resolveClaim;
export const closeClaim = service.closeClaim;
