import { getPrimaryPool } from "./pool-factory.js";

export function getPoolForTenant(_tenantId) {
  // V1 uses a shared database. Keep all pool selection behind this function so
  // a future tenant-to-shard map does not change services or DAOs.
  return getPrimaryPool();
}
