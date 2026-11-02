import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";

export async function activeSession({ userId, sessionId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT s.id FROM user_sessions s
    JOIN users u ON u.id=s.user_id AND u.status='ACTIVE' AND u.deleted_at IS NULL
    WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>UTC_TIMESTAMP(6)`,
  [uuidToBuffer(sessionId), uuidToBuffer(userId)]);
  return rows.length === 1;
}

export async function overview({ includeTenants, connection = getPrimaryPool() }) {
  const [[row]] = await connection.execute(`SELECT
    (SELECT COUNT(*) FROM tenants WHERE deleted_at IS NULL) AS total_tenants,
    (SELECT COUNT(*) FROM tenants WHERE deleted_at IS NULL AND status='ACTIVE') AS active_tenants,
    (SELECT COUNT(*) FROM tenants WHERE deleted_at IS NULL AND status='PENDING') AS pending_tenants,
    (SELECT COUNT(*) FROM tenants WHERE deleted_at IS NULL AND status='SUSPENDED') AS suspended_tenants,
    (SELECT COUNT(*) FROM stores s JOIN tenants t ON t.id=s.tenant_id
      WHERE s.deleted_at IS NULL AND s.status='ACTIVE' AND t.deleted_at IS NULL AND t.status='ACTIVE') AS active_stores,
    (SELECT COUNT(*) FROM users u WHERE u.status='ACTIVE' AND u.deleted_at IS NULL AND EXISTS
      (SELECT 1 FROM tenant_memberships tm JOIN tenants t ON t.id=tm.tenant_id
        WHERE tm.user_id=u.id AND tm.status='ACTIVE' AND t.status='ACTIVE' AND t.deleted_at IS NULL)) AS active_staff`);
  let recentTenants = [];
  if (includeTenants) {
    const [rows] = await connection.execute(`SELECT t.id,t.display_name,t.status,t.updated_at,
      (SELECT COUNT(*) FROM stores s WHERE s.tenant_id=t.id AND s.deleted_at IS NULL) AS stores,
      (SELECT COUNT(DISTINCT tm.user_id) FROM tenant_memberships tm
        JOIN users u ON u.id=tm.user_id AND u.deleted_at IS NULL AND u.status='ACTIVE'
        WHERE tm.tenant_id=t.id AND tm.status='ACTIVE') AS staff
      FROM tenants t WHERE t.deleted_at IS NULL ORDER BY t.updated_at DESC,t.id DESC LIMIT 10`);
    recentTenants = rows.map((item) => ({ id: bufferToUuid(item.id), name: item.display_name, status: item.status,
      updatedAt: item.updated_at instanceof Date ? item.updated_at.toISOString() : item.updated_at,
      stores: Number(item.stores), staff: Number(item.staff) }));
  }
  return { summary: { totalTenants: Number(row.total_tenants), activeTenants: Number(row.active_tenants),
    pendingTenants: Number(row.pending_tenants), suspendedTenants: Number(row.suspended_tenants),
    activeStores: Number(row.active_stores), activeTenantStaff: Number(row.active_staff) }, recentTenants };
}
