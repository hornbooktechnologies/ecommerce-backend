import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function mapPermission(row) {
  return {
    // Permission IDs are deterministic UNHEX(MD5(permission_key)) values. They
    // are 16 bytes wide, but they are not guaranteed to contain valid RFC UUID
    // version/variant bits, so the strict UUID formatter cannot map them.
    id: Buffer.from(row.id).toString("hex"),
    key: row.permission_key,
    module: row.module_name,
    description: row.description
  };
}

function mapRoleBase(row) {
  return {
    id: bufferToUuid(row.id),
    key: row.role_key,
    name: row.name,
    level: row.role_level,
    isSystem: Boolean(row.is_system),
    assignedUsers: Number(row.assigned_users || 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export async function findTenantAccess({ userId, tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT t.status AS tenant_status, tm.status AS membership_status,
            a.id AS assignment_id, a.scope_type, a.scope_id,
            r.id AS role_id, r.role_key, r.name AS role_name, r.role_level,
            p.permission_key
       FROM tenant_memberships tm
       JOIN tenants t ON t.id = tm.tenant_id AND t.deleted_at IS NULL
       LEFT JOIN user_role_assignments a
         ON a.user_id = tm.user_id AND a.tenant_id = tm.tenant_id AND a.revoked_at IS NULL
       LEFT JOIN roles r ON r.id = a.role_id AND r.deleted_at IS NULL
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE tm.tenant_id = ? AND tm.user_id = ?
      ORDER BY r.name, p.permission_key`,
    [uuidToBuffer(tenantId), uuidToBuffer(userId)]
  );

  if (!rows.length) return null;
  const assignments = new Map();
  for (const row of rows) {
    if (!row.assignment_id) continue;
    const id = bufferToUuid(row.assignment_id);
    if (!assignments.has(id)) {
      assignments.set(id, {
        id,
        roleId: bufferToUuid(row.role_id),
        roleKey: row.role_key,
        roleName: row.role_name,
        roleLevel: row.role_level,
        scopeType: row.scope_type,
        scopeId: bufferToUuid(row.scope_id),
        permissions: []
      });
    }
    if (row.permission_key) assignments.get(id).permissions.push(row.permission_key);
  }

  return {
    tenantStatus: rows[0].tenant_status,
    membershipStatus: rows[0].membership_status,
    assignments: [...assignments.values()]
  };
}

export async function listPermissions({ connection = getPrimaryPool() } = {}) {
  const [rows] = await connection.execute(
    `SELECT id, permission_key, module_name, description
       FROM permissions
      WHERE permission_key NOT LIKE 'platform.%'
      ORDER BY module_name, permission_key`
  );
  return rows.map(mapPermission);
}

export async function listRoles({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT r.id, r.role_key, r.name, r.role_level, r.is_system,
            r.created_at, r.updated_at, p.permission_key,
            (SELECT COUNT(DISTINCT a.user_id) FROM user_role_assignments a
              WHERE a.role_id = r.id AND a.revoked_at IS NULL) AS assigned_users
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE r.tenant_id = ? AND r.deleted_at IS NULL
      GROUP BY r.id, r.role_key, r.name, r.role_level, r.is_system,
               r.created_at, r.updated_at, p.permission_key
      ORDER BY r.is_system DESC, r.name, p.permission_key`,
    [uuidToBuffer(tenantId)]
  );

  const roles = new Map();
  for (const row of rows) {
    const id = bufferToUuid(row.id);
    if (!roles.has(id)) roles.set(id, { ...mapRoleBase(row), permissions: [] });
    if (row.permission_key) roles.get(id).permissions.push(row.permission_key);
  }
  return [...roles.values()];
}

export async function findRoleById({ tenantId, roleId, connection = getPrimaryPool(), forUpdate = false }) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.execute(
    `SELECT id, role_key, name, role_level, is_system, created_at, updated_at
       FROM roles
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1${lock}`,
    [uuidToBuffer(roleId), uuidToBuffer(tenantId)]
  );
  return rows[0] ? mapRoleBase(rows[0]) : null;
}

export async function findRoleByKey({ tenantId, roleKey, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT id FROM roles
      WHERE tenant_id = ? AND role_key = ? AND deleted_at IS NULL LIMIT 1`,
    [uuidToBuffer(tenantId), roleKey]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id) } : null;
}

export async function permissionsExist({ permissionKeys, connection = getPrimaryPool() }) {
  if (!permissionKeys.length) return [];
  const placeholders = permissionKeys.map(() => "?").join(", ");
  const [rows] = await connection.execute(
    `SELECT permission_key FROM permissions WHERE permission_key IN (${placeholders})`,
    permissionKeys
  );
  return rows.map((row) => row.permission_key);
}

export async function insertRole({ role, connection }) {
  await connection.execute(
    `INSERT INTO roles (id, tenant_id, role_key, name, role_level, is_system)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [uuidToBuffer(role.id), uuidToBuffer(role.tenantId), role.key, role.name, role.level]
  );
}

export async function updateRole({ tenantId, roleId, name, connection }) {
  await connection.execute(
    `UPDATE roles SET name = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    [name, uuidToBuffer(roleId), uuidToBuffer(tenantId)]
  );
}

export async function replaceRolePermissions({ roleId, permissionKeys, connection }) {
  await connection.execute("DELETE FROM role_permissions WHERE role_id = ?", [uuidToBuffer(roleId)]);
  if (!permissionKeys.length) return;
  const placeholders = permissionKeys.map(() => "?").join(", ");
  await connection.execute(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT ?, id FROM permissions WHERE permission_key IN (${placeholders})`,
    [uuidToBuffer(roleId), ...permissionKeys]
  );
}

export async function softDeleteRole({ tenantId, roleId, connection }) {
  const [result] = await connection.execute(
    `UPDATE roles SET deleted_at = UTC_TIMESTAMP(6)
      WHERE id = ? AND tenant_id = ? AND is_system = 0 AND deleted_at IS NULL`,
    [uuidToBuffer(roleId), uuidToBuffer(tenantId)]
  );
  return result.affectedRows === 1;
}

export async function countActiveRoleAssignments({ roleId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS total FROM user_role_assignments
      WHERE role_id = ? AND revoked_at IS NULL`,
    [uuidToBuffer(roleId)]
  );
  return Number(rows[0].total || 0);
}

export async function listUsers({ tenantId, search, status, page, pageSize, connection = getPrimaryPool() }) {
  const where = ["tm.tenant_id = ?", "u.deleted_at IS NULL"];
  const parameters = [uuidToBuffer(tenantId)];
  if (search) {
    const term = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    where.push("(u.email LIKE ? ESCAPE '\\\\' OR u.first_name LIKE ? ESCAPE '\\\\' OR u.last_name LIKE ? ESCAPE '\\\\')");
    parameters.push(term, term, term);
  }
  if (status !== "ALL") {
    where.push("tm.status = ?");
    parameters.push(status);
  }
  const clause = where.join(" AND ");
  const offset = (page - 1) * pageSize;
  const [countRows] = await connection.execute(
    `SELECT COUNT(*) AS total FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id WHERE ${clause}`,
    parameters
  );
  const [summaryRows] = await connection.execute(
    `SELECT COUNT(*) AS total,
            SUM(tm.status = 'ACTIVE') AS active,
            SUM(tm.status = 'INVITED') AS invited,
            SUM(tm.status = 'SUSPENDED') AS suspended
       FROM tenant_memberships tm
       JOIN users u ON u.id = tm.user_id AND u.deleted_at IS NULL
      WHERE tm.tenant_id = ?`,
    [uuidToBuffer(tenantId)]
  );
  const [rows] = await connection.execute(
    `SELECT members.id, members.email, members.first_name, members.last_name,
            members.user_status, members.membership_type, members.membership_status,
            members.invited_at, members.joined_at, a.id AS assignment_id,
            a.scope_type, a.scope_id, r.id AS role_id, r.name AS role_name, r.role_key, r.role_level
       FROM (
         SELECT u.id, u.email, u.first_name, u.last_name, u.status AS user_status,
                tm.membership_type, tm.status AS membership_status, tm.invited_at, tm.joined_at, tm.created_at
           FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id
          WHERE ${clause}
          ORDER BY tm.created_at DESC, u.email
          LIMIT ? OFFSET ?
       ) members
       LEFT JOIN user_role_assignments a
         ON a.user_id = members.id AND a.tenant_id = ? AND a.revoked_at IS NULL
       LEFT JOIN roles r ON r.id = a.role_id AND r.deleted_at IS NULL
      ORDER BY members.created_at DESC, members.email, r.name`,
    [...parameters, pageSize, offset, uuidToBuffer(tenantId)]
  );

  const users = new Map();
  for (const row of rows) {
    const id = bufferToUuid(row.id);
    if (!users.has(id)) {
      users.set(id, {
        id,
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
        displayName: [row.first_name, row.last_name].filter(Boolean).join(" "),
        userStatus: row.user_status,
        membershipType: row.membership_type,
        status: row.membership_status,
        invitedAt: iso(row.invited_at),
        joinedAt: iso(row.joined_at),
        assignments: []
      });
    }
    if (row.assignment_id) {
      users.get(id).assignments.push({
        id: bufferToUuid(row.assignment_id),
        roleId: bufferToUuid(row.role_id),
        roleName: row.role_name,
        roleKey: row.role_key,
        roleLevel: row.role_level,
        scopeType: row.scope_type,
        scopeId: bufferToUuid(row.scope_id)
      });
    }
  }
  const summary = summaryRows[0];
  return {
    items: [...users.values()],
    total: Number(countRows[0].total || 0),
    summary: {
      total: Number(summary.total || 0),
      active: Number(summary.active || 0),
      invited: Number(summary.invited || 0),
      suspended: Number(summary.suspended || 0)
    }
  };
}

export async function findUserByEmail({ email, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT id, status FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1`,
    [email]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), status: rows[0].status } : null;
}

export async function insertInvitedUser({ user, connection }) {
  await connection.execute(
    `INSERT INTO users (id, email, password_hash, first_name, last_name, status, password_changed_at)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(6))`,
    [uuidToBuffer(user.id), user.email, user.passwordHash, user.firstName, user.lastName || null]
  );
}

export async function findMembership({ tenantId, userId, connection = getPrimaryPool(), forUpdate = false }) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.execute(
    `SELECT id, membership_type, status FROM tenant_memberships
      WHERE tenant_id = ? AND user_id = ? LIMIT 1${lock}`,
    [uuidToBuffer(tenantId), uuidToBuffer(userId)]
  );
  return rows[0] ? {
    id: bufferToUuid(rows[0].id),
    membershipType: rows[0].membership_type,
    status: rows[0].status
  } : null;
}

export async function insertMembership({ membership, connection }) {
  await connection.execute(
    `INSERT INTO tenant_memberships
      (id, tenant_id, user_id, membership_type, status, invited_by, invited_at)
     VALUES (?, ?, ?, 'STAFF', 'INVITED', ?, UTC_TIMESTAMP(6))`,
    [uuidToBuffer(membership.id), uuidToBuffer(membership.tenantId),
      uuidToBuffer(membership.userId), uuidToBuffer(membership.invitedBy)]
  );
}

export async function touchInvitation({ tenantId, userId, invitedBy, connection }) {
  await connection.execute(
    `UPDATE tenant_memberships
        SET invited_by = ?, invited_at = UTC_TIMESTAMP(6), status = 'INVITED'
      WHERE tenant_id = ? AND user_id = ? AND membership_type <> 'OWNER'`,
    [uuidToBuffer(invitedBy), uuidToBuffer(tenantId), uuidToBuffer(userId)]
  );
}

export async function updateMembershipStatus({ tenantId, userId, status, connection }) {
  const joined = status === "ACTIVE" ? ", joined_at = COALESCE(joined_at, UTC_TIMESTAMP(6))" : "";
  const [result] = await connection.execute(
    `UPDATE tenant_memberships SET status = ?${joined}
      WHERE tenant_id = ? AND user_id = ?`,
    [status, uuidToBuffer(tenantId), uuidToBuffer(userId)]
  );
  return result.affectedRows === 1;
}

export async function rolesBelongToTenant({ tenantId, roleIds, connection = getPrimaryPool() }) {
  if (!roleIds.length) return [];
  const placeholders = roleIds.map(() => "?").join(", ");
  const [rows] = await connection.execute(
    `SELECT id FROM roles WHERE tenant_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`,
    [uuidToBuffer(tenantId), ...roleIds.map(uuidToBuffer)]
  );
  return rows.map((row) => bufferToUuid(row.id));
}

export async function scopeBelongsToTenant({ tenantId, scopeType, scopeId, connection = getPrimaryPool() }) {
  if (scopeType === "TENANT") return scopeId === tenantId;
  const tables = {
    STORE: ["stores", "deleted_at IS NULL"],
    MERCHANT: ["merchants", "deleted_at IS NULL"],
    WAREHOUSE: ["warehouses", "deleted_at IS NULL"]
  };
  const definition = tables[scopeType];
  if (!definition) return false;
  const [table, activeClause] = definition;
  const [rows] = await connection.execute(
    `SELECT 1 FROM ${table} WHERE id = ? AND tenant_id = ? AND ${activeClause} LIMIT 1`,
    [uuidToBuffer(scopeId), uuidToBuffer(tenantId)]
  );
  return rows.length === 1;
}

export async function revokeRoleAssignments({ tenantId, userId, connection }) {
  await connection.execute(
    `UPDATE user_role_assignments SET revoked_at = UTC_TIMESTAMP(6)
      WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`,
    [uuidToBuffer(tenantId), uuidToBuffer(userId)]
  );
}

export async function insertRoleAssignment({ assignment, connection }) {
  await connection.execute(
    `INSERT INTO user_role_assignments
      (id, user_id, tenant_id, role_id, scope_type, scope_id, assigned_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       revoked_at = NULL,
       assigned_by = VALUES(assigned_by),
       created_at = UTC_TIMESTAMP(6)`,
    [uuidToBuffer(assignment.id), uuidToBuffer(assignment.userId),
      uuidToBuffer(assignment.tenantId), uuidToBuffer(assignment.roleId), assignment.scopeType,
      assignment.scopeId ? uuidToBuffer(assignment.scopeId) : null, uuidToBuffer(assignment.assignedBy)]
  );
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(
    `INSERT INTO audit_logs
      (id, tenant_id, actor_user_id, actor_type, action, entity_type, entity_id,
       request_id, ip_address, user_agent, before_data, after_data, metadata)
     VALUES (?, ?, ?, 'USER', ?, ?, ?, ?, INET6_ATON(?), ?, ?, ?, ?)`,
    [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId),
      audit.action, audit.entityType, uuidToBuffer(audit.entityId), audit.requestId,
      audit.ipAddress || null, audit.userAgent || null,
      audit.beforeData ? JSON.stringify(audit.beforeData) : null,
      audit.afterData ? JSON.stringify(audit.afterData) : null,
      audit.metadata ? JSON.stringify(audit.metadata) : null]
  );
}

export async function insertOutbox({ event, connection }) {
  await connection.execute(
    `INSERT INTO outbox_events
      (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(event.id), uuidToBuffer(event.tenantId), event.aggregateType,
      uuidToBuffer(event.aggregateId), event.type, JSON.stringify(event.payload)]
  );
}
