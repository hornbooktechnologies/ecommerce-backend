import * as defaultService from "./dashboard.service.js";

export function createDashboardController(service = defaultService) {
  return { async overview(req, res) {
    res.json({ data: await service.getOverview(req.context.tenant.tenantId) });
  } };
}
