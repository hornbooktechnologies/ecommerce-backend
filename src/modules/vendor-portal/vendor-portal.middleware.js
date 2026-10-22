import { AppError } from "../../core/errors/app-error.js";
import * as accessDao from "../access-control/access-control.dao.js";
import * as vendorDao from "../vendors/vendors.dao.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolveVendorAccess(req, _res, next) {
  const tenantId = req.get("x-tenant-id") || "";
  if (!uuidPattern.test(tenantId)) return next(new AppError({
    code: "TENANT_CONTEXT_REQUIRED", message: "Select a tenant workspace to continue.", status: 400
  }));

  const access = await accessDao.findTenantAccess({ userId: req.context.actor.userId, tenantId });
  if (!access || access.membershipStatus !== "ACTIVE" || access.tenantStatus !== "ACTIVE") {
    return next(new AppError({ code: "VENDOR_ACCESS_DENIED",
      message: "You do not have active access to this workspace.", status: 403 }));
  }
  const vendorAssignments = access.assignments.filter((assignment) =>
    assignment.roleLevel === "VENDOR" && assignment.scopeType === "MERCHANT" && assignment.scopeId);
  const requestedMerchantId = req.get("x-merchant-id") || "";
  const merchantIds = [...new Set(vendorAssignments.map((assignment) => assignment.scopeId))];
  const merchantId = requestedMerchantId || (merchantIds.length === 1 ? merchantIds[0] : "");
  if (!uuidPattern.test(merchantId) || !merchantIds.includes(merchantId)) {
    return next(new AppError({ code: "VENDOR_CONTEXT_REQUIRED",
      message: "Select an assigned vendor workspace to continue.", status: 403 }));
  }
  const merchant = await vendorDao.getVendor({ tenantId, vendorId: merchantId });
  if (!merchant) return next(new AppError({ code: "VENDOR_ACCESS_DENIED",
    message: "This vendor workspace is not available.", status: 403 }));

  req.context = Object.freeze({ ...req.context, vendor: Object.freeze({ tenantId, merchantId,
    merchant: merchant.vendor, assignments: vendorAssignments.filter((entry) => entry.scopeId === merchantId) }) });
  next();
}

export function requireVendorPermission(permissionKey) {
  return (req, _res, next) => {
    const allowed = req.context.vendor.assignments.some((assignment) =>
      assignment.permissions.includes(permissionKey));
    if (!allowed) return next(new AppError({ code: "FORBIDDEN",
      message: "You do not have permission to perform this action.", status: 403 }));
    next();
  };
}
