import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";

function mapUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: bufferToUuid(row.id),
    email: row.email,
    passwordHash: row.password_hash,
    firstName: row.first_name,
    lastName: row.last_name,
    status: row.status,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at
  };
}

export async function findUserByEmail({ email, connection = getPrimaryPool(), forUpdate = false }) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.execute(
    `SELECT id, email, password_hash, first_name, last_name, status,
            failed_login_count, locked_until, last_login_at
       FROM users
      WHERE email = ?
        AND deleted_at IS NULL
      LIMIT 1${lock}`,
    [email]
  );

  return mapUser(rows[0]);
}

export async function findUserById({ userId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT id, email, password_hash, first_name, last_name, status,
            failed_login_count, locked_until, last_login_at
       FROM users
      WHERE id = ?
        AND deleted_at IS NULL
      LIMIT 1`,
    [uuidToBuffer(userId)]
  );

  return mapUser(rows[0]);
}

export async function findUserByIdForUpdate({ userId, connection }) {
  const [rows] = await connection.execute(
    `SELECT id, email, password_hash, first_name, last_name, status,
            failed_login_count, locked_until, last_login_at
       FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(userId)]
  );
  return mapUser(rows[0]);
}

export async function countRecentPasswordResetRequests({ userId, connection }) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS request_count FROM password_reset_tokens
      WHERE user_id = ? AND created_at >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 15 MINUTE)`,
    [uuidToBuffer(userId)]
  );
  return Number(rows[0]?.request_count || 0);
}

export async function invalidatePasswordResetTokens({ userId, connection, exceptId = null }) {
  const parameters = [uuidToBuffer(userId)];
  const except = exceptId ? " AND id <> ?" : "";
  if (exceptId) parameters.push(uuidToBuffer(exceptId));
  await connection.execute(
    `UPDATE password_reset_tokens SET used_at = COALESCE(used_at, UTC_TIMESTAMP(6))
      WHERE user_id = ? AND used_at IS NULL${except}`,
    parameters
  );
}

export async function insertPasswordResetToken({ reset, connection }) {
  await connection.execute(
    `INSERT INTO password_reset_tokens
       (id, user_id, token_hash, requested_ip, user_agent, expires_at)
     VALUES (?, ?, ?, INET6_ATON(?), ?, ?)`,
    [uuidToBuffer(reset.id), uuidToBuffer(reset.userId), reset.tokenHash,
      reset.ipAddress || null, reset.userAgent || null, reset.expiresAt]
  );
}

export async function findPasswordResetTokenForUpdate({ tokenHash, connection }) {
  const [rows] = await connection.execute(
    `SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at,
            u.email, u.password_hash, u.first_name, u.last_name, u.status,
            u.failed_login_count, u.locked_until, u.last_login_at
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id AND u.deleted_at IS NULL
      WHERE prt.token_hash = ? LIMIT 1 FOR UPDATE`, [tokenHash]
  );
  if (!rows[0]) return null;
  return { id: bufferToUuid(rows[0].id), userId: bufferToUuid(rows[0].user_id),
    expiresAt: rows[0].expires_at, usedAt: rows[0].used_at,
    user: mapUser({ ...rows[0], id: rows[0].user_id }) };
}

export async function markPasswordResetTokenUsed({ resetId, connection }) {
  await connection.execute(
    "UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP(6) WHERE id = ? AND used_at IS NULL",
    [uuidToBuffer(resetId)]
  );
}

export async function updatePassword({ userId, passwordHash, connection }) {
  await connection.execute(
    `UPDATE users SET password_hash = ?, password_changed_at = UTC_TIMESTAMP(6),
       failed_login_count = 0, locked_until = NULL WHERE id = ?`,
    [passwordHash, uuidToBuffer(userId)]
  );
}

export async function revokeUserSessions({ userId, connection }) {
  await connection.execute(
    `UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(6)
      WHERE user_id = ? AND revoked_at IS NULL`, [uuidToBuffer(userId)]
  );
}

export async function recordFailedLogin({ userId, connection }) {
  await connection.execute(
    `UPDATE users
        SET failed_login_count = failed_login_count + 1,
            locked_until = CASE
              WHEN failed_login_count + 1 >= 5
              THEN DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 15 MINUTE)
              ELSE locked_until
            END
      WHERE id = ?`,
    [uuidToBuffer(userId)]
  );
}

export async function recordSuccessfulLogin({ userId, connection }) {
  await connection.execute(
    `UPDATE users
        SET failed_login_count = 0,
            locked_until = NULL,
            last_login_at = UTC_TIMESTAMP(6)
      WHERE id = ?`,
    [uuidToBuffer(userId)]
  );
}

export async function insertSession({ session, connection }) {
  await connection.execute(
    `INSERT INTO user_sessions (
       id, user_id, refresh_token_hash, device_name, ip_address,
       user_agent, expires_at
     ) VALUES (?, ?, ?, ?, INET6_ATON(?), ?, ?)`,
    [
      uuidToBuffer(session.id),
      uuidToBuffer(session.userId),
      session.refreshTokenHash,
      session.deviceName,
      session.ipAddress,
      session.userAgent,
      session.expiresAt
    ]
  );
}

export async function findSessionForUpdate({ refreshTokenHash, connection }) {
  const [rows] = await connection.execute(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at,
            u.email, u.password_hash, u.first_name, u.last_name,
            u.status, u.failed_login_count, u.locked_until, u.last_login_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = ?
        AND u.deleted_at IS NULL
      LIMIT 1
      FOR UPDATE`,
    [refreshTokenHash]
  );

  if (!rows[0]) {
    return null;
  }

  return {
    id: bufferToUuid(rows[0].id),
    userId: bufferToUuid(rows[0].user_id),
    expiresAt: rows[0].expires_at,
    revokedAt: rows[0].revoked_at,
    user: mapUser({ ...rows[0], id: rows[0].user_id })
  };
}

export async function revokeSession({ sessionId, connection }) {
  const [result] = await connection.execute(
    `UPDATE user_sessions
        SET revoked_at = UTC_TIMESTAMP(6)
      WHERE id = ?
        AND revoked_at IS NULL`,
    [uuidToBuffer(sessionId)]
  );

  return result.affectedRows === 1;
}

export async function revokeSessionByTokenHash({ refreshTokenHash, connection = getPrimaryPool() }) {
  await connection.execute(
    `UPDATE user_sessions
        SET revoked_at = UTC_TIMESTAMP(6)
      WHERE refresh_token_hash = ?
        AND revoked_at IS NULL`,
    [refreshTokenHash]
  );
}

export async function listRoleAssignments({ userId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT a.id, a.tenant_id, a.scope_type, a.scope_id,
            r.role_key, r.name AS role_name, r.role_level, p.permission_key,
            t.display_name AS tenant_name, m.display_name AS scope_name
       FROM user_role_assignments a
       JOIN roles r ON r.id = a.role_id
       LEFT JOIN tenants t ON t.id = a.tenant_id AND t.deleted_at IS NULL
       LEFT JOIN merchants m ON m.id = a.scope_id AND a.scope_type = 'MERCHANT' AND m.deleted_at IS NULL
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE a.user_id = ?
        AND a.revoked_at IS NULL
        AND r.deleted_at IS NULL
        AND (
          (a.tenant_id IS NULL AND (
            r.role_level <> 'PLATFORM' OR EXISTS (
              SELECT 1 FROM platform_memberships pm
               WHERE pm.user_id = a.user_id AND pm.status = 'ACTIVE'
            )
          )) OR EXISTS (
            SELECT 1 FROM tenant_memberships tm
            JOIN tenants t ON t.id = tm.tenant_id
            WHERE tm.user_id = a.user_id
              AND tm.tenant_id = a.tenant_id
              AND tm.status = 'ACTIVE'
              AND t.status = 'ACTIVE'
              AND t.deleted_at IS NULL
          )
        )
      ORDER BY r.role_level, r.name, p.permission_key`,
    [uuidToBuffer(userId)]
  );

  const assignments = new Map();
  for (const row of rows) {
    const id = bufferToUuid(row.id);
    if (!assignments.has(id)) {
      assignments.set(id, {
        id,
        tenantId: bufferToUuid(row.tenant_id),
        tenantName: row.tenant_name,
        scopeName: row.scope_name,
        scopeType: row.scope_type,
        scopeId: bufferToUuid(row.scope_id),
        roleKey: row.role_key,
        roleName: row.role_name,
        roleLevel: row.role_level,
        permissions: []
      });
    }
    if (row.permission_key) assignments.get(id).permissions.push(row.permission_key);
  }
  return [...assignments.values()];
}

export async function hasActivePlatformRole({ userId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT 1
       FROM user_role_assignments a
       JOIN roles r ON r.id = a.role_id
       JOIN users u ON u.id = a.user_id
       JOIN platform_memberships pm ON pm.user_id = a.user_id AND pm.status = 'ACTIVE'
      WHERE a.user_id = ?
        AND a.tenant_id IS NULL
        AND a.scope_type = 'PLATFORM'
        AND a.revoked_at IS NULL
        AND r.role_level = 'PLATFORM'
        AND r.deleted_at IS NULL
        AND u.status = 'ACTIVE'
        AND u.deleted_at IS NULL
      LIMIT 1`,
    [uuidToBuffer(userId)]
  );

  return rows.length === 1;
}
