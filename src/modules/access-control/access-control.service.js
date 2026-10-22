import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { hashPassword } from "../../core/security/password.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./access-control.dao.js";

function error(code, message, status, details = []) {
  return new AppError({ code, message, status, details });
}

function roleNotFound() {
  return error("ROLE_NOT_FOUND", "The role could not be found.", 404);
}

function auditContext(context) {
  return {
    actorUserId: context.actorUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress || null,
    userAgent: context.userAgent?.slice(0, 500) || null
  };
}

function records({ tenantId, entityId, entityType, action, actor, beforeData = null, afterData = null, metadata = null }) {
  return {
    audit: {
      id: createId(), tenantId, entityId, entityType, action,
      ...auditContext(actor), beforeData, afterData, metadata
    },
    event: {
      id: createId(), tenantId, aggregateId: entityId, aggregateType: entityType,
      type: action, payload: { tenantId, entityId, ...afterData, ...(metadata ? { metadata } : {}) }
    }
  };
}

function roleKey(name) {
  const value = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return value.slice(0, 70) || `custom_${Date.now()}`;
}

function handleDuplicate(errorValue, field = "name") {
  if (errorValue?.code === "ER_DUP_ENTRY") {
    throw error("DUPLICATE_VALUE", "That value is already in use.", 409, [
      { field, code: "unique", message: "Choose a different value." }
    ]);
  }
  throw errorValue;
}

export function createAccessControlService({
  dao = defaultDao,
  transaction = withTransaction,
  passwordHasher = hashPassword
} = {}) {
  async function getRole(tenantId, roleId) {
    const roles = await dao.listRoles({ tenantId });
    const role = roles.find((item) => item.id === roleId);
    if (!role) throw roleNotFound();
    return role;
  }

  async function validatePermissions(permissionKeys, connection) {
    const uniqueKeys = [...new Set(permissionKeys)];
    const found = await dao.permissionsExist({ permissionKeys: uniqueKeys, connection });
    if (found.length !== uniqueKeys.length) {
      const unknown = uniqueKeys.filter((key) => !found.includes(key));
      throw error("UNKNOWN_PERMISSION", "One or more permissions are not available.", 422,
        unknown.map((key) => ({ field: "permissionKeys", code: "unknown", message: key })));
    }
    return uniqueKeys;
  }

  async function createRole(tenantId, input, context) {
    const id = createId();
    try {
      await transaction(tenantId, async (connection) => {
        const permissionKeys = await validatePermissions(input.permissionKeys, connection);
        let key = roleKey(input.name);
        if (await dao.findRoleByKey({ tenantId, roleKey: key, connection })) key = `${key}_${id.slice(0, 6)}`;
        await dao.insertRole({ role: { id, tenantId, key, name: input.name, level: input.level }, connection });
        await dao.replaceRolePermissions({ roleId: id, permissionKeys, connection });
        const mutation = records({
          tenantId, entityId: id, entityType: "ROLE", action: "settings.role.created",
          actor: context, afterData: { name: input.name, level: input.level, permissionKeys }
        });
        await dao.insertAudit({ audit: mutation.audit, connection });
        await dao.insertOutbox({ event: mutation.event, connection });
      });
    } catch (caught) {
      handleDuplicate(caught);
    }
    return getRole(tenantId, id);
  }

  async function updateRole(tenantId, roleId, input, context) {
    await transaction(tenantId, async (connection) => {
      const current = await dao.findRoleById({ tenantId, roleId, connection, forUpdate: true });
      if (!current) throw roleNotFound();
      const permissionKeys = input.permissionKeys
        ? await validatePermissions(input.permissionKeys, connection)
        : null;
      await dao.updateRole({ tenantId, roleId, name: input.name ?? current.name, connection });
      if (permissionKeys) await dao.replaceRolePermissions({ roleId, permissionKeys, connection });
      const mutation = records({
        tenantId, entityId: roleId, entityType: "ROLE", action: "settings.role.updated",
        actor: context, beforeData: { name: current.name },
        afterData: { name: input.name ?? current.name, ...(permissionKeys ? { permissionKeys } : {}) }
      });
      await dao.insertAudit({ audit: mutation.audit, connection });
      await dao.insertOutbox({ event: mutation.event, connection });
    });
    return getRole(tenantId, roleId);
  }

  async function deleteRole(tenantId, roleId, context) {
    await transaction(tenantId, async (connection) => {
      const current = await dao.findRoleById({ tenantId, roleId, connection, forUpdate: true });
      if (!current) throw roleNotFound();
      if (current.isSystem) throw error("SYSTEM_ROLE_IMMUTABLE", "System roles cannot be deleted.", 409);
      if (await dao.countActiveRoleAssignments({ roleId, connection })) {
        throw error("ROLE_IN_USE", "Remove this role from all users before deleting it.", 409);
      }
      await dao.softDeleteRole({ tenantId, roleId, connection });
      const mutation = records({
        tenantId, entityId: roleId, entityType: "ROLE", action: "settings.role.deleted",
        actor: context, beforeData: { name: current.name }
      });
      await dao.insertAudit({ audit: mutation.audit, connection });
      await dao.insertOutbox({ event: mutation.event, connection });
    });
  }

  async function inviteUser(tenantId, input, context) {
    let invitedUserId;
    await transaction(tenantId, async (connection) => {
      const email = input.email.trim().toLowerCase();
      let user = await dao.findUserByEmail({ email, connection });
      if (user && user.status !== "ACTIVE") {
        throw error("USER_ACCOUNT_UNAVAILABLE", "This user account is not active.", 409);
      }
      if (!user) {
        user = {
          id: createId(), email, firstName: input.firstName, lastName: input.lastName,
          passwordHash: await passwordHasher(input.temporaryPassword)
        };
        await dao.insertInvitedUser({ user, connection });
      }
      invitedUserId = user.id;
      const existing = await dao.findMembership({ tenantId, userId: user.id, connection, forUpdate: true });
      if (existing?.status === "ACTIVE") {
        throw error("MEMBERSHIP_EXISTS", "This user already belongs to the tenant.", 409);
      }
      if (existing) {
        await dao.touchInvitation({ tenantId, userId: user.id, invitedBy: context.actorUserId, connection });
      } else {
        await dao.insertMembership({ membership: {
          id: createId(), tenantId, userId: user.id, invitedBy: context.actorUserId
        }, connection });
      }
      await replaceAssignments(tenantId, user.id, input.assignments, context, connection);
      const mutation = records({
        tenantId, entityId: user.id, entityType: "USER", action: "settings.user.invited",
        actor: context, afterData: { email, status: "INVITED" }
      });
      await dao.insertAudit({ audit: mutation.audit, connection });
      await dao.insertOutbox({ event: mutation.event, connection });
    });
    return { id: invitedUserId, email: input.email.trim().toLowerCase(), status: "INVITED" };
  }

  async function replaceAssignments(tenantId, userId, assignments, context, connection) {
    const roleIds = [...new Set(assignments.map((assignment) => assignment.roleId))];
    const matchingRoles = await dao.rolesBelongToTenant({ tenantId, roleIds, connection });
    if (matchingRoles.length !== roleIds.length) {
      throw error("INVALID_ROLE_SCOPE", "Every role must belong to the active tenant.", 422);
    }
    for (const assignment of assignments) {
      const scopeId = assignment.scopeType === "TENANT" ? tenantId : assignment.scopeId;
      if (!await dao.scopeBelongsToTenant({ tenantId, scopeType: assignment.scopeType, scopeId, connection })) {
        throw error("INVALID_RESOURCE_SCOPE", "A selected scope does not belong to the active tenant.", 422);
      }
    }
    await dao.revokeRoleAssignments({ tenantId, userId, connection });
    for (const assignment of assignments) {
      await dao.insertRoleAssignment({
        assignment: {
          id: createId(), tenantId, userId, roleId: assignment.roleId,
          scopeType: assignment.scopeType,
          scopeId: assignment.scopeType === "TENANT" ? tenantId : assignment.scopeId,
          assignedBy: context.actorUserId
        },
        connection
      });
    }
  }

  async function setRoleAssignments(tenantId, userId, assignments, context) {
    await transaction(tenantId, async (connection) => {
      const membership = await dao.findMembership({ tenantId, userId, connection, forUpdate: true });
      if (!membership) throw error("TENANT_USER_NOT_FOUND", "The tenant user could not be found.", 404);
      if (membership.membershipType === "OWNER") {
        throw error("OWNER_ASSIGNMENT_IMMUTABLE", "The tenant owner's role assignment cannot be replaced.", 409);
      }
      await replaceAssignments(tenantId, userId, assignments, context, connection);
      const mutation = records({
        tenantId, entityId: userId, entityType: "USER", action: "settings.role.assigned",
        actor: context, afterData: { assignments }
      });
      await dao.insertAudit({ audit: mutation.audit, connection });
      await dao.insertOutbox({ event: mutation.event, connection });
    });
    return { userId, assignments };
  }

  async function changeMembershipStatus(tenantId, userId, status, context) {
    if (userId === context.actorUserId && status === "SUSPENDED") {
      throw error("SELF_SUSPENSION_NOT_ALLOWED", "You cannot suspend your own tenant access.", 409);
    }
    await transaction(tenantId, async (connection) => {
      const membership = await dao.findMembership({ tenantId, userId, connection, forUpdate: true });
      if (!membership) throw error("TENANT_USER_NOT_FOUND", "The tenant user could not be found.", 404);
      if (membership.membershipType === "OWNER" && status === "SUSPENDED") {
        throw error("OWNER_SUSPENSION_NOT_ALLOWED", "Transfer ownership before suspending the tenant owner.", 409);
      }
      await dao.updateMembershipStatus({ tenantId, userId, status, connection });
      const mutation = records({
        tenantId, entityId: userId, entityType: "USER", action: `settings.user.${status.toLowerCase()}`,
        actor: context, beforeData: { status: membership.status }, afterData: { status }
      });
      await dao.insertAudit({ audit: mutation.audit, connection });
      await dao.insertOutbox({ event: mutation.event, connection });
    });
    return { id: userId, status };
  }

  return {
    listUsers: async (tenantId, input) => {
      const result = await dao.listUsers({ tenantId, ...input });
      return { ...result, page: input.page, pageSize: input.pageSize,
        totalPages: Math.max(1, Math.ceil(result.total / input.pageSize)) };
    },
    listRoles: (tenantId) => dao.listRoles({ tenantId }),
    getRole,
    listPermissions: () => dao.listPermissions(),
    createRole,
    updateRole,
    deleteRole,
    inviteUser,
    setRoleAssignments,
    activateUser: (tenantId, userId, context) => changeMembershipStatus(tenantId, userId, "ACTIVE", context),
    suspendUser: (tenantId, userId, context) => changeMembershipStatus(tenantId, userId, "SUSPENDED", context)
  };
}

const service = createAccessControlService();
export const listUsers = service.listUsers;
export const listRoles = service.listRoles;
export const getRole = service.getRole;
export const listPermissions = service.listPermissions;
export const createRole = service.createRole;
export const updateRole = service.updateRole;
export const deleteRole = service.deleteRole;
export const inviteUser = service.inviteUser;
export const setRoleAssignments = service.setRoleAssignments;
export const activateUser = service.activateUser;
export const suspendUser = service.suspendUser;
