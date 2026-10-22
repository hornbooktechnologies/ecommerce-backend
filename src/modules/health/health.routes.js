import { Router } from "express";
import { getPrimaryPool } from "../../database/pool-factory.js";

export function createHealthRouter({ readinessCheck = defaultReadinessCheck } = {}) {
  const router = Router();

  router.get("/live", (_req, res) => {
    res.json({
      data: {
        status: "ok",
        service: "ecommerce-api"
      }
    });
  });

  router.get("/ready", async (_req, res) => {
    const checks = await readinessCheck();
    const ready = Object.values(checks).every((check) => check.status === "up");

    res.status(ready ? 200 : 503).json({
      data: {
        status: ready ? "ready" : "not-ready",
        checks
      }
    });
  });

  return router;
}

async function defaultReadinessCheck() {
  try {
    await getPrimaryPool().query("SELECT 1");
    return { database: { status: "up" } };
  } catch {
    return { database: { status: "down" } };
  }
}
