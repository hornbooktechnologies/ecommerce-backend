import * as defaultTenantService from "./platform-tenants.service.js";

function mutationContext(req) {
  return {
    actorUserId: req.context.actor.userId,
    requestId: req.context.requestId,
    ipAddress: req.ip,
    userAgent: req.get("user-agent") || null
  };
}

export function createPlatformTenantController(tenantService = defaultTenantService) {
  async function transition(req, res, action) {
    const tenant = await tenantService[action](
      req.validated.params.tenantId,
      req.validated.body.reason,
      mutationContext(req)
    );
    res.json({ data: { tenant } });
  }

  return {
    async list(req, res) {
      const result = await tenantService.listTenants(req.validated.query);
      res.json({ data: result });
    },

    async create(req, res) {
      const tenant = await tenantService.createTenant(req.validated.body, mutationContext(req));
      res.status(201).json({ data: { tenant } });
    },

    async get(req, res) {
      const tenant = await tenantService.getTenant(req.validated.params.tenantId);
      res.json({ data: { tenant } });
    },

    async update(req, res) {
      const tenant = await tenantService.updateTenant(
        req.validated.params.tenantId,
        req.validated.body,
        mutationContext(req)
      );
      res.json({ data: { tenant } });
    },

    activate(req, res) {
      return transition(req, res, "activateTenant");
    },

    suspend(req, res) {
      return transition(req, res, "suspendTenant");
    },

    restore(req, res) {
      return transition(req, res, "restoreTenant");
    }
  };
}
