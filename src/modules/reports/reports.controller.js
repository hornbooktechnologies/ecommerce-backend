import * as defaultService from "./reports.service.js";

export function createReportsController(service = defaultService) {
  const tenantId = (req) => req.context.tenant.tenantId;
  return {
    async report(req, res) { res.json({ data: await service.getReport(tenantId(req), req.validated.query) }); },
    async exportCsv(req, res) {
      const result = await service.exportReport(tenantId(req), req.validated.query);
      res.set("content-type", "text/csv; charset=utf-8");
      res.set("content-disposition", `attachment; filename="${result.filename}"`);
      res.send(result.csv);
    }
  };
}
