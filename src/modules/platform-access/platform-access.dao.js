import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";

const iso = (value) => value instanceof Date ? value.toISOString() : value;
const mapPermission = (row) => ({
  id: Buffer.from(row.id).toString("hex"),
  key: row.permission_key,
  module: row.module_name,
  description: row.description
});
const mapRole = (row) => ({
  id: bufferToUuid(row.id),
  key: row.role_key,
  name: row.name,
  level: row.role_level,
  isSystem: Boolean(row.is_system),
  assignedUsers: Number(row.assigned_users || 0),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

export async function findPlatformAccess({ userId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT pm.status AS membership_status, r.role_key, p.permission_key
       FROM platform_memberships pm
       JOIN users u ON u.id = pm.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
       LEFT JOIN user_role_assignments a ON a.user_id = pm.user_id AND a.tenant_id IS NULL
        AND a.scope_type = 'PLATFORM' AND a.revoked_at IS NULL
       LEFT JOIN roles r ON r.id = a.role_id AND r.role_level = 'PLATFORM' AND r.deleted_at IS NULL
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE pm.user_id = ? ORDER BY r.name, p.permission_key`, [uuidToBuffer(userId)]);
  if (!rows.length || rows[0].membership_status !== "ACTIVE") return null;
  const roleKeys = [...new Set(rows.map((row) => row.role_key).filter(Boolean))];
  return { roleKeys, permissions: [...new Set(rows.map((row) => row.permission_key).filter(Boolean))],
    unrestricted: roleKeys.includes("platform_super_admin") };
}

export async function listPermissions({ connection = getPrimaryPool() } = {}) {
  const [rows] = await connection.execute(`SELECT id, permission_key, module_name, description
    FROM permissions WHERE permission_key LIKE 'platform.%' ORDER BY module_name, permission_key`);
  return rows.map(mapPermission);
}

export async function permissionsExist({ permissionKeys, connection = getPrimaryPool() }) {
  if (!permissionKeys.length) return [];
  const placeholders = permissionKeys.map(() => "?").join(", ");
  const [rows] = await connection.execute(`SELECT permission_key FROM permissions
    WHERE permission_key LIKE 'platform.%' AND permission_key IN (${placeholders})`, permissionKeys);
  return rows.map((row) => row.permission_key);
}

export async function listRoles({ connection = getPrimaryPool() } = {}) {
  const [rows] = await connection.execute(
    `SELECT r.id, r.role_key, r.name, r.role_level, r.is_system, r.created_at, r.updated_at,
            p.permission_key, (SELECT COUNT(DISTINCT a.user_id) FROM user_role_assignments a
              JOIN platform_memberships pm ON pm.user_id = a.user_id
              WHERE a.role_id = r.id AND a.revoked_at IS NULL AND pm.status <> 'SUSPENDED') assigned_users
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE r.tenant_id IS NULL AND r.role_level = 'PLATFORM' AND r.deleted_at IS NULL
      GROUP BY r.id, r.role_key, r.name, r.role_level, r.is_system, r.created_at, r.updated_at, p.permission_key
      ORDER BY r.is_system DESC, r.name, p.permission_key`);
  const roles = new Map();
  for (const row of rows) {
    const id = bufferToUuid(row.id);
    if (!roles.has(id)) roles.set(id, { ...mapRole(row), permissions: [] });
    if (row.permission_key) roles.get(id).permissions.push(row.permission_key);
  }
  return [...roles.values()];
}

export async function findRoleById({ roleId, connection = getPrimaryPool(), forUpdate = false }) {
  const [rows] = await connection.execute(`SELECT id, role_key, name, role_level, is_system, created_at, updated_at
    FROM roles WHERE id = ? AND tenant_id IS NULL AND role_level = 'PLATFORM' AND deleted_at IS NULL
    LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`, [uuidToBuffer(roleId)]);
  return rows[0] ? mapRole(rows[0]) : null;
}

export async function findRoleByKey({ roleKey, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT id FROM roles WHERE tenant_id IS NULL
    AND role_level = 'PLATFORM' AND role_key = ? AND deleted_at IS NULL LIMIT 1`, [roleKey]);
  return rows[0] ? { id: bufferToUuid(rows[0].id) } : null;
}

export async function insertRole({ role, connection }) {
  await connection.execute(`INSERT INTO roles (id, tenant_id, role_key, name, role_level, is_system)
    VALUES (?, NULL, ?, ?, 'PLATFORM', 0)`, [uuidToBuffer(role.id), role.key, role.name]);
}

export async function updateRole({ roleId, name, connection }) {
  await connection.execute(`UPDATE roles SET name = ? WHERE id = ? AND tenant_id IS NULL
    AND role_level = 'PLATFORM' AND is_system = 0 AND deleted_at IS NULL`, [name, uuidToBuffer(roleId)]);
}

export async function replaceRolePermissions({ roleId, permissionKeys, connection }) {
  await connection.execute("DELETE FROM role_permissions WHERE role_id = ?", [uuidToBuffer(roleId)]);
  if (!permissionKeys.length) return;
  const placeholders = permissionKeys.map(() => "?").join(", ");
  await connection.execute(`INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions
    WHERE permission_key LIKE 'platform.%' AND permission_key IN (${placeholders})`,
  [uuidToBuffer(roleId), ...permissionKeys]);
}

export async function softDeleteRole({ roleId, connection }) {
  const [result] = await connection.execute(`UPDATE roles SET deleted_at = UTC_TIMESTAMP(6)
    WHERE id = ? AND tenant_id IS NULL AND role_level = 'PLATFORM' AND is_system = 0 AND deleted_at IS NULL`,
  [uuidToBuffer(roleId)]);
  return result.affectedRows === 1;
}

export async function countActiveRoleAssignments({ roleId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT COUNT(DISTINCT a.user_id) total FROM user_role_assignments a
    JOIN platform_memberships pm ON pm.user_id = a.user_id AND pm.status <> 'SUSPENDED'
    WHERE a.role_id = ? AND a.revoked_at IS NULL`, [uuidToBuffer(roleId)]);
  return Number(rows[0].total || 0);
}

export async function listUsers({ search, status, page, pageSize, connection = getPrimaryPool() }) {
  const where = ["u.deleted_at IS NULL"];
  const parameters = [];
  if (search) {
    const term = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    where.push("(u.email LIKE ? ESCAPE '\\\\' OR u.first_name LIKE ? ESCAPE '\\\\' OR u.last_name LIKE ? ESCAPE '\\\\')");
    parameters.push(term, term, term);
  }
  if (status !== "ALL") { where.push("pm.status = ?"); parameters.push(status); }
  const clause = where.join(" AND ");
  const offset = (page - 1) * pageSize;
  const [countRows] = await connection.execute(
    `SELECT COUNT(*) total FROM platform_memberships pm JOIN users u ON u.id = pm.user_id WHERE ${clause}`,
    parameters);
  const [summaryRows] = await connection.execute(`SELECT COUNT(*) total,
    SUM(pm.status = 'ACTIVE') active, SUM(pm.status = 'INVITED') invited,
    SUM(pm.status = 'SUSPENDED') suspended FROM platform_memberships pm
    JOIN users u ON u.id = pm.user_id AND u.deleted_at IS NULL`);
  const [rows] = await connection.execute(
    `SELECT members.*, a.id assignment_id, r.id role_id, r.name role_name, r.role_key, r.role_level
       FROM (SELECT u.id, u.email, u.first_name, u.last_name, u.status user_status,
              u.last_login_at, pm.status membership_status, pm.invited_at, pm.joined_at, pm.created_at
         FROM platform_memberships pm JOIN users u ON u.id = pm.user_id WHERE ${clause}
         ORDER BY pm.created_at DESC, u.email LIMIT ? OFFSET ?) members
       LEFT JOIN user_role_assignments a ON a.user_id = members.id AND a.tenant_id IS NULL
        AND a.scope_type = 'PLATFORM' AND a.revoked_at IS NULL
       LEFT JOIN roles r ON r.id = a.role_id AND r.deleted_at IS NULL
      ORDER BY members.created_at DESC, members.email, r.name`, [...parameters, pageSize, offset]);
  const users = new Map();
  for (const row of rows) {
    const id = bufferToUuid(row.id);
    if (!users.has(id)) users.set(id, { id, email: row.email, firstName: row.first_name,
      lastName: row.last_name, displayName: [row.first_name, row.last_name].filter(Boolean).join(" "),
      userStatus: row.user_status, status: row.membership_status, invitedAt: iso(row.invited_at),
      joinedAt: iso(row.joined_at), lastLoginAt: iso(row.last_login_at), assignments: [] });
    if (row.assignment_id) users.get(id).assignments.push({ id: bufferToUuid(row.assignment_id),
      roleId: bufferToUuid(row.role_id), roleName: row.role_name, roleKey: row.role_key,
      roleLevel: row.role_level, scopeType: "PLATFORM", scopeId: null });
  }
  const summary = summaryRows[0];
  return { items: [...users.values()], total: Number(countRows[0].total || 0), summary: {
    total: Number(summary.total || 0), active: Number(summary.active || 0),
    invited: Number(summary.invited || 0), suspended: Number(summary.suspended || 0) } };
}

export async function findUserByEmail({ email, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    "SELECT id, status FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1", [email]);
  return rows[0] ? { id: bufferToUuid(rows[0].id), status: rows[0].status } : null;
}

export async function insertInvitedUser({ user, connection }) {
  await connection.execute(`INSERT INTO users
    (id, email, password_hash, first_name, last_name, status, password_changed_at)
    VALUES (?, ?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(6))`,
  [uuidToBuffer(user.id), user.email, user.passwordHash, user.firstName, user.lastName || null]);
}

export async function findMembership({ userId, connection = getPrimaryPool(), forUpdate = false }) {
  const [rows] = await connection.execute(`SELECT user_id, status FROM platform_memberships
    WHERE user_id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`, [uuidToBuffer(userId)]);
  return rows[0] ? { userId: bufferToUuid(rows[0].user_id), status: rows[0].status } : null;
}

export async function insertMembership({ membership, connection }) {
  await connection.execute(`INSERT INTO platform_memberships (user_id, status, invited_by, invited_at)
    VALUES (?, 'INVITED', ?, UTC_TIMESTAMP(6))`,
  [uuidToBuffer(membership.userId), uuidToBuffer(membership.invitedBy)]);
}

export async function touchInvitation({ userId, invitedBy, connection }) {
  await connection.execute(`UPDATE platform_memberships SET invited_by = ?,
    invited_at = UTC_TIMESTAMP(6), status = 'INVITED' WHERE user_id = ?`,
  [uuidToBuffer(invitedBy), uuidToBuffer(userId)]);
}

export async function updateMembershipStatus({ userId, status, connection }) {
  const joined = status === "ACTIVE" ? ", joined_at = COALESCE(joined_at, UTC_TIMESTAMP(6))" : "";
  const [result] = await connection.execute(
    `UPDATE platform_memberships SET status = ?${joined} WHERE user_id = ?`,
    [status, uuidToBuffer(userId)]);
  return result.affectedRows === 1;
}

export async function rolesBelongToPlatform({ roleIds, connection = getPrimaryPool() }) {
  if (!roleIds.length) return [];
  const placeholders = roleIds.map(() => "?").join(", ");
  const [rows] = await connection.execute(`SELECT id FROM roles WHERE tenant_id IS NULL
    AND role_level = 'PLATFORM' AND id IN (${placeholders}) AND deleted_at IS NULL`,
  roleIds.map(uuidToBuffer));
  return rows.map((row) => bufferToUuid(row.id));
}

export async function revokeRoleAssignments({ userId, connection }) {
  await connection.execute(`UPDATE user_role_assignments SET revoked_at = UTC_TIMESTAMP(6)
    WHERE user_id = ? AND tenant_id IS NULL AND scope_type = 'PLATFORM' AND revoked_at IS NULL`,
  [uuidToBuffer(userId)]);
}

export async function insertRoleAssignment({ assignment, connection }) {
  await connection.execute(`INSERT INTO user_role_assignments
    (id, user_id, tenant_id, role_id, scope_type, scope_id, assigned_by)
    VALUES (?, ?, NULL, ?, 'PLATFORM', NULL, ?)`,
  [uuidToBuffer(assignment.id), uuidToBuffer(assignment.userId),
    uuidToBuffer(assignment.roleId), uuidToBuffer(assignment.assignedBy)]);
}

export async function userHasRole({ userId, roleKey, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT 1 FROM user_role_assignments a
    JOIN roles r ON r.id = a.role_id WHERE a.user_id = ? AND a.tenant_id IS NULL
    AND a.scope_type = 'PLATFORM' AND a.revoked_at IS NULL AND r.role_key = ?
    AND r.deleted_at IS NULL LIMIT 1`, [uuidToBuffer(userId), roleKey]);
  return rows.length === 1;
}

export async function countActiveSuperAdmins({ connection = getPrimaryPool() } = {}) {
  const [rows] = await connection.execute(`SELECT COUNT(DISTINCT a.user_id) total
    FROM user_role_assignments a JOIN roles r ON r.id = a.role_id
    JOIN platform_memberships pm ON pm.user_id = a.user_id AND pm.status = 'ACTIVE'
    JOIN users u ON u.id = a.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
    WHERE a.tenant_id IS NULL AND a.scope_type = 'PLATFORM' AND a.revoked_at IS NULL
    AND r.role_key = 'platform_super_admin' AND r.deleted_at IS NULL`);
  return Number(rows[0].total || 0);
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(`INSERT INTO audit_logs
    (id, tenant_id, actor_user_id, actor_type, action, entity_type, entity_id,
     request_id, ip_address, user_agent, before_data, after_data, metadata)
    VALUES (?, NULL, ?, 'USER', ?, ?, ?, ?, INET6_ATON(?), ?, ?, ?, ?)`,
  [uuidToBuffer(audit.id), uuidToBuffer(audit.actorUserId), audit.action, audit.entityType,
    uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress || null, audit.userAgent || null,
    audit.beforeData ? JSON.stringify(audit.beforeData) : null,
    audit.afterData ? JSON.stringify(audit.afterData) : null,
    audit.metadata ? JSON.stringify(audit.metadata) : null]);
}

export async function insertOutbox({ event, connection }) {
  await connection.execute(`INSERT INTO outbox_events
    (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
    VALUES (?, NULL, ?, ?, ?, ?)`, [uuidToBuffer(event.id), event.aggregateType,
    uuidToBuffer(event.aggregateId), event.type, JSON.stringify(event.payload)]);
}
