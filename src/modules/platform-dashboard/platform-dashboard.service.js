import { AppError } from "../../core/errors/app-error.js";
import { getPrimaryPool } from "../../database/pool-factory.js";
import * as dao from "./platform-dashboard.dao.js";

export function createPlatformDashboardService({ database = getPrimaryPool, dashboardDao = dao } = {}) {
  return { async overview(context) {
    if (!context.actor || !await dashboardDao.activeSession(context.actor)) {
      throw new AppError({ code: "AUTHENTICATION_REQUIRED", message: "Your session is invalid or has expired.", status: 401 });
    }
    const access = context.platform;
    const can = (permission) => Boolean(access?.unrestricted || access?.permissions.includes(permission));
    if (!can("platform.dashboard.read")) throw new AppError({ code: "FORBIDDEN", message: "You do not have access to the platform overview.", status: 403 });
    const includeTenants = can("platform.tenant.read");
    const connection = await database().getConnection();
    try {
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      const result = await dashboardDao.overview({ includeTenants, connection });
      await connection.commit();
      return { ...result, generatedAt: new Date().toISOString(), canReadTenants: includeTenants };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  } };
}
