import { AppError } from "../../core/errors/app-error.js";
import * as accessDao from "./access-control.dao.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolveTenantAccess(req, _res, next) {
  const tenantId = req.get("x-tenant-id") || "";
  if (!uuidPattern.test(tenantId)) {
    return next(new AppError({
      code: "TENANT_CONTEXT_REQUIRED",
      message: "Select a tenant workspace to continue.",
      status: 400
    }));
  }

  const access = await accessDao.findTenantAccess({ userId: req.context.actor.userId, tenantId });
  if (!access || access.membershipStatus !== "ACTIVE" || access.tenantStatus !== "ACTIVE") {
    return next(new AppError({
      code: "TENANT_ACCESS_DENIED",
      message: "You do not have active access to this tenant.",
      status: 403
    }));
  }

  req.context = Object.freeze({
    ...req.context,
    tenant: Object.freeze({ tenantId, assignments: access.assignments })
  });
  next();
}

export function requirePermission(permissionKey) {
  return (req, _res, next) => {
    const allowed = req.context.tenant.assignments.some((assignment) =>
      assignment.scopeType === "TENANT" && assignment.permissions.includes(permissionKey));
    if (!allowed) {
      return next(new AppError({
        code: "FORBIDDEN",
        message: "You do not have permission to perform this action.",
        status: 403
      }));
    }
    next();
  };
}
