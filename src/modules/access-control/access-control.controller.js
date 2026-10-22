import * as defaultService from "./access-control.service.js";

function context(req) {
  return {
    actorUserId: req.context.actor.userId,
    requestId: req.context.requestId,
    ipAddress: req.ip,
    userAgent: req.get("user-agent") || null
  };
}

export function createAccessControlController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async listUsers(req, res) {
      res.json({ data: await service.listUsers(tenantId(req), req.validated.query) });
    },
    async inviteUser(req, res) {
      const user = await service.inviteUser(tenantId(req), req.validated.body, context(req));
      res.status(201).json({ data: { user } });
    },
    async activateUser(req, res) {
      const user = await service.activateUser(tenantId(req), req.validated.params.userId, context(req));
      res.json({ data: { user } });
    },
    async suspendUser(req, res) {
      const user = await service.suspendUser(tenantId(req), req.validated.params.userId, context(req));
      res.json({ data: { user } });
    },
    async setRoleAssignments(req, res) {
      const result = await service.setRoleAssignments(
        tenantId(req), req.validated.params.userId, req.validated.body.assignments, context(req)
      );
      res.json({ data: result });
    },
    async listRoles(req, res) {
      res.json({ data: { items: await service.listRoles(tenantId(req)) } });
    },
    async getRole(req, res) {
      res.json({ data: { role: await service.getRole(tenantId(req), req.validated.params.roleId) } });
    },
    async createRole(req, res) {
      const role = await service.createRole(tenantId(req), req.validated.body, context(req));
      res.status(201).json({ data: { role } });
    },
    async updateRole(req, res) {
      const role = await service.updateRole(
        tenantId(req), req.validated.params.roleId, req.validated.body, context(req)
      );
      res.json({ data: { role } });
    },
    async deleteRole(req, res) {
      await service.deleteRole(tenantId(req), req.validated.params.roleId, context(req));
      res.status(204).send();
    },
    async listPermissions(_req, res) {
      res.json({ data: { items: await service.listPermissions() } });
    }
  };
}
