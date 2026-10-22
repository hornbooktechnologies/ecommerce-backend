import * as defaultDao from "./dashboard.dao.js";

export function createDashboardService({ dao = defaultDao } = {}) {
  async function getOverview(tenantId) { return dao.getDashboardOverview({ tenantId }); }
  return { getOverview };
}

const service = createDashboardService();
export const { getOverview } = service;
