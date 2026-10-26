import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePlatformPermission } from "../platform-tenants/platform-authorization.middleware.js";
import * as defaultService from "./platform-access.service.js";
import { createPlatformAccessController } from "./platform-access.controller.js";
import { assignmentsSchema, inviteUserSchema, listUsersSchema, roleIdSchema, roleSchema,
  updateRoleSchema, userIdSchema, validateBody, validateParams, validateQuery } from "./platform-access.validators.js";

export function createPlatformAccessRouter({ platformAccessService = defaultService,
  authorize = requirePlatformPermission } = {}) {
  const router = Router();
  const controller = createPlatformAccessController(platformAccessService);
  const guard = (permission) => typeof authorize === "function" && authorize.length >= 3
    ? authorize : authorize(permission);
  router.use(authenticate);
  router.get("/users", guard("platform.user.read"), validateQuery(listUsersSchema), controller.listUsers);
  router.post("/users/invitations", guard("platform.user.invite"), validateBody(inviteUserSchema), controller.inviteUser);
  router.post("/users/:userId/activate", guard("platform.user.manage"), validateParams(userIdSchema), controller.activateUser);
  router.post("/users/:userId/suspend", guard("platform.user.manage"), validateParams(userIdSchema), controller.suspendUser);
  router.put("/users/:userId/role-assignments", guard("platform.role.assign"), validateParams(userIdSchema),
    validateBody(assignmentsSchema), controller.setRoleAssignments);
  router.get("/roles", guard("platform.role.read"), controller.listRoles);
  router.post("/roles", guard("platform.role.create"), validateBody(roleSchema), controller.createRole);
  router.get("/roles/:roleId", guard("platform.role.read"), validateParams(roleIdSchema), controller.getRole);
  router.patch("/roles/:roleId", guard("platform.role.update"), validateParams(roleIdSchema),
    validateBody(updateRoleSchema), controller.updateRole);
  router.delete("/roles/:roleId", guard("platform.role.delete"), validateParams(roleIdSchema), controller.deleteRole);
  router.get("/permissions", guard("platform.role.read"), controller.listPermissions);
  return router;
}
