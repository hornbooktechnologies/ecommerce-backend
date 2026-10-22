import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import * as defaultService from "./access-control.service.js";
import { createAccessControlController } from "./access-control.controller.js";
import { requirePermission, resolveTenantAccess } from "./access-control.middleware.js";
import {
  assignmentsSchema, inviteUserSchema, listUsersSchema, roleIdSchema, roleSchema,
  updateRoleSchema, userIdSchema, validateBody, validateParams, validateQuery
} from "./access-control.validators.js";

export function createAccessControlRouter({
  accessControlService = defaultService,
  resolveTenant = resolveTenantAccess,
  authorize = requirePermission
} = {}) {
  const router = Router();
  const controller = createAccessControlController(accessControlService);
  router.use(authenticate, resolveTenant);

  router.get("/users", authorize("settings.user.read"), validateQuery(listUsersSchema), controller.listUsers);
  router.post("/users/invitations", authorize("settings.user.invite"), validateBody(inviteUserSchema), controller.inviteUser);
  router.post("/users/:userId/activate", authorize("settings.user.manage"), validateParams(userIdSchema), controller.activateUser);
  router.post("/users/:userId/suspend", authorize("settings.user.manage"), validateParams(userIdSchema), controller.suspendUser);
  router.put("/users/:userId/role-assignments", authorize("settings.role.assign"),
    validateParams(userIdSchema), validateBody(assignmentsSchema), controller.setRoleAssignments);

  router.get("/roles", authorize("settings.role.read"), controller.listRoles);
  router.post("/roles", authorize("settings.role.create"), validateBody(roleSchema), controller.createRole);
  router.get("/roles/:roleId", authorize("settings.role.read"), validateParams(roleIdSchema), controller.getRole);
  router.patch("/roles/:roleId", authorize("settings.role.update"),
    validateParams(roleIdSchema), validateBody(updateRoleSchema), controller.updateRole);
  router.delete("/roles/:roleId", authorize("settings.role.delete"), validateParams(roleIdSchema), controller.deleteRole);
  router.get("/permissions", authorize("settings.role.read"), controller.listPermissions);

  return router;
}
