import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { requirePlatformPermission } from "../platform-tenants/platform-authorization.middleware.js";
import { createPlatformDashboardService } from "./platform-dashboard.service.js";

export function createPlatformDashboardRouter({ service = createPlatformDashboardService(), authorize = requirePlatformPermission } = {}) {
  const router = Router();
  router.get("/", authenticate, authorize("platform.dashboard.read"), async (req, res) => {
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    res.json({ data: await service.overview(req.context) });
  });
  return router;
}
