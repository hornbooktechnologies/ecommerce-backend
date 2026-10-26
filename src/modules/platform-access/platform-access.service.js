import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { hashPassword } from "../../core/security/password.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./platform-access.dao.js";

const failure = (code, message, status, details = []) => new AppError({ code, message, status, details });
const roleMissing = () => failure("PLATFORM_ROLE_NOT_FOUND", "The platform role could not be found.", 404);
const memberMissing = () => failure("PLATFORM_MEMBER_NOT_FOUND", "The platform team member could not be found.", 404);
const actor = (context) => ({ actorUserId: context.actorUserId, requestId: context.requestId,
  ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null });

function records({ entityId, entityType, action, context, beforeData = null, afterData = null }) {
  return {
    audit: { id: createId(), tenantId: null, entityId, entityType, action, ...actor(context),
      beforeData, afterData },
    event: { id: createId(), tenantId: null, aggregateId: entityId, aggregateType: entityType,
      type: action, payload: { entityId, ...afterData } }
  };
}

function keyFor(name) {
  const value = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `platform_${value.slice(0, 60) || Date.now()}`;
}

function duplicate(error) {
  if (error?.code === "ER_DUP_ENTRY") {
    throw failure("DUPLICATE_VALUE", "That value is already in use.", 409,
      [{ field: "name", code: "unique", message: "Choose a different value." }]);
  }
  throw error;
}

export function createPlatformAccessService({ dao = defaultDao, transaction = withTransaction,
  passwordHasher = hashPassword } = {}) {
  async function getRole(roleId) {
    const role = (await dao.listRoles()).find((item) => item.id === roleId);
    if (!role) throw roleMissing();
    return role;
  }

  async function validPermissions(permissionKeys, connection) {
    const unique = [...new Set(permissionKeys)];
    const found = await dao.permissionsExist({ permissionKeys: unique, connection });
    if (found.length !== unique.length) {
      const unknown = unique.filter((key) => !found.includes(key));
      throw failure("UNKNOWN_PLATFORM_PERMISSION", "One or more platform permissions are unavailable.", 422,
        unknown.map((key) => ({ field: "permissionKeys", code: "unknown", message: key })));
    }
    return unique;
  }

  async function createRole(input, context) {
    const id = createId();
    try {
      await transaction(null, async (connection) => {
        const permissionKeys = await validPermissions(input.permissionKeys, connection);
        let key = keyFor(input.name);
        if (await dao.findRoleByKey({ roleKey: key, connection })) key = `${key}_${id.slice(0, 6)}`;
        await dao.insertRole({ role: { id, key, name: input.name }, connection });
        await dao.replaceRolePermissions({ roleId: id, permissionKeys, connection });
        const mutation = records({ entityId: id, entityType: "PLATFORM_ROLE",
          action: "platform.role.created", context, afterData: { name: input.name, permissionKeys } });
        await dao.insertAudit({ audit: mutation.audit, connection });
        await dao.insertOutbox({ event: mutation.event, connection });
      });
    } catch (error) { duplicate(error); }
    return getRole(id);
  }

  async function updateRole(roleId, input, context) {
    await transaction(null, async (connection) => {
      const current = await dao.findRoleById({ roleId, connection, forUpdate: true });
      if (!current) throw roleMissing();
      if (current.isSystem) throw failure("SYSTEM_ROLE_IMMUTABLE", "System platform roles cannot be changed.", 409);
      const permissionKeys = input.permissionKeys
        ? await validPermissions(input.permissionKeys, connection) : null;
      await dao.updateRole({ roleId, name: input.name ?? current.name, connection });
      if (permissionKeys) await dao.replaceRolePermissions({ roleId, permissionKeys, connection });
      const mutation = records({ entityId: roleId, entityType: "PLATFORM_ROLE",
        action: "platform.role.updated", context, beforeData: { name: current.name },
        afterData: { name: input.name ?? current.name, ...(permissionKeys ? { permissionKeys } : {}) } });
      await dao.insertAudit({ audit: mutation.audit, connection });
      await dao.insertOutbox({ event: mutation.event, connection });
    });
    return getRole(roleId);
  }

  async function deleteRole(roleId, context) {
    await transaction(null, async (connection) => {
      const current = await dao.findRoleById({ roleId, connection, forUpdate: true });
      if (!current) throw roleMissing();
      if (current.isSystem) throw failure("SYSTEM_ROLE_IMMUTABLE", "System platform roles cannot be deleted.", 409);
      if (await dao.countActiveRoleAssignments({ roleId, connection })) {
        throw failure("ROLE_IN_USE", "Remove this role from every platform member before deleting it.", 409);
      }
      await dao.softDeleteRole({ roleId, connection });
      const mutation = records({ entityId: roleId, entityType: "PLATFORM_ROLE",
        action: "platform.role.deleted", context, beforeData: { name: current.name } });
      await dao.insertAudit({ audit: mutation.audit, connection });
      await dao.insertOutbox({ event: mutation.event, connection });
    });
  }

  async function replaceAssignments(userId, roleIds, context, connection) {
    const unique = [...new Set(roleIds)];
    const matching = await dao.rolesBelongToPlatform({ roleIds: unique, connection });
    if (matching.length !== unique.length) {
      throw failure("INVALID_PLATFORM_ROLE", "Every selected role must be a current platform role.", 422);
    }
    await dao.revokeRoleAssignments({ userId, connection });
    for (const roleId of unique) {
      await dao.insertRoleAssignment({ assignment: { id: createId(), userId, roleId,
        assignedBy: context.actorUserId }, connection });
    }
  }

  async function inviteUser(input, context) {
    let invitedUserId;
    await transaction(null, async (connection) => {
      const email = input.email.trim().toLowerCase();
      let user = await dao.findUserByEmail({ email, connection });
      if (user && user.status !== "ACTIVE") {
        throw failure("USER_ACCOUNT_UNAVAILABLE", "This user account is not active.", 409);
      }
      if (!user) {
        user = { id: createId(), email, firstName: input.firstName, lastName: input.lastName,
          passwordHash: await passwordHasher(input.temporaryPassword) };
        await dao.insertInvitedUser({ user, connection });
      }
      invitedUserId = user.id;
      const membership = await dao.findMembership({ userId: user.id, connection, forUpdate: true });
      if (membership?.status === "ACTIVE") {
        throw failure("PLATFORM_MEMBERSHIP_EXISTS", "This user already has active platform access.", 409);
      }
      if (membership) await dao.touchInvitation({ userId: user.id, invitedBy: context.actorUserId, connection });
      else await dao.insertMembership({ membership: { userId: user.id,
        invitedBy: context.actorUserId }, connection });
      await replaceAssignments(user.id, input.roleIds, context, connection);
      const mutation = records({ entityId: user.id, entityType: "PLATFORM_USER",
        action: "platform.user.invited", context, afterData: { email, status: "INVITED" } });
      await dao.insertAudit({ audit: mutation.audit, connection });
      await dao.insertOutbox({ event: mutation.event, connection });
    });
    return { id: invitedUserId, email: input.email.trim().toLowerCase(), status: "INVITED" };
  }

  async function setRoleAssignments(userId, roleIds, context) {
    if (userId === context.actorUserId) {
      throw failure("SELF_ROLE_CHANGE_NOT_ALLOWED", "You cannot change your own platform roles.", 409);
    }
    await transaction(null, async (connection) => {
      if (!await dao.findMembership({ userId, connection, forUpdate: true })) throw memberMissing();
      if (await dao.userHasRole({ userId, roleKey: "platform_super_admin", connection })
        && await dao.countActiveSuperAdmins({ connection }) <= 1) {
        throw failure("LAST_SUPER_ADMIN_PROTECTED", "Assign another active super administrator first.", 409);
      }
      await replaceAssignments(userId, roleIds, context, connection);
      const mutation = records({ entityId: userId, entityType: "PLATFORM_USER",
        action: "platform.role.assigned", context, afterData: { roleIds } });
      await dao.insertAudit({ audit: mutation.audit, connection });
      await dao.insertOutbox({ event: mutation.event, connection });
    });
    return { userId, roleIds };
  }

  async function changeStatus(userId, status, context) {
    if (userId === context.actorUserId && status === "SUSPENDED") {
      throw failure("SELF_SUSPENSION_NOT_ALLOWED", "You cannot suspend your own platform access.", 409);
    }
    await transaction(null, async (connection) => {
      const membership = await dao.findMembership({ userId, connection, forUpdate: true });
      if (!membership) throw memberMissing();
      if (status === "SUSPENDED" && await dao.userHasRole({ userId,
        roleKey: "platform_super_admin", connection }) && await dao.countActiveSuperAdmins({ connection }) <= 1) {
        throw failure("LAST_SUPER_ADMIN_PROTECTED", "Assign another active super administrator first.", 409);
      }
      await dao.updateMembershipStatus({ userId, status, connection });
      const mutation = records({ entityId: userId, entityType: "PLATFORM_USER",
        action: `platform.user.${status.toLowerCase()}`, context,
        beforeData: { status: membership.status }, afterData: { status } });
      await dao.insertAudit({ audit: mutation.audit, connection });
      await dao.insertOutbox({ event: mutation.event, connection });
    });
    return { id: userId, status };
  }

  return {
    listUsers: async (input) => { const result = await dao.listUsers(input); return { ...result,
      page: input.page, pageSize: input.pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / input.pageSize)) }; },
    listRoles: () => dao.listRoles(),
    getRole,
    listPermissions: () => dao.listPermissions(),
    createRole, updateRole, deleteRole, inviteUser, setRoleAssignments,
    activateUser: (userId, context) => changeStatus(userId, "ACTIVE", context),
    suspendUser: (userId, context) => changeStatus(userId, "SUSPENDED", context)
  };
}

const service = createPlatformAccessService();
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
