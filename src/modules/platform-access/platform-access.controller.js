import * as defaultService from "./platform-access.service.js";

const context = (req) => ({ actorUserId: req.context.actor.userId, requestId: req.context.requestId,
  ipAddress: req.ip, userAgent: req.get("user-agent") || null });

export function createPlatformAccessController(service = defaultService) {
  return {
    async listUsers(req, res) { res.json({ data: await service.listUsers(req.validated.query) }); },
    async inviteUser(req, res) { res.status(201).json({ data: { user:
      await service.inviteUser(req.validated.body, context(req)) } }); },
    async activateUser(req, res) { res.json({ data: { user:
      await service.activateUser(req.validated.params.userId, context(req)) } }); },
    async suspendUser(req, res) { res.json({ data: { user:
      await service.suspendUser(req.validated.params.userId, context(req)) } }); },
    async setRoleAssignments(req, res) { res.json({ data: await service.setRoleAssignments(
      req.validated.params.userId, req.validated.body.roleIds, context(req)) }); },
    async listRoles(_req, res) { res.json({ data: { items: await service.listRoles() } }); },
    async getRole(req, res) { res.json({ data: { role: await service.getRole(req.validated.params.roleId) } }); },
    async createRole(req, res) { res.status(201).json({ data: { role:
      await service.createRole(req.validated.body, context(req)) } }); },
    async updateRole(req, res) { res.json({ data: { role: await service.updateRole(
      req.validated.params.roleId, req.validated.body, context(req)) } }); },
    async deleteRole(req, res) { await service.deleteRole(req.validated.params.roleId, context(req));
      res.status(204).send(); },
    async listPermissions(_req, res) { res.json({ data: { items: await service.listPermissions() } }); }
  };
}
