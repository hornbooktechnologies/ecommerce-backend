import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function mapTenant(row) {
  if (!row) {
    return null;
  }

  return {
    id: bufferToUuid(row.id),
    code: row.code,
    legalName: row.legal_name,
    displayName: row.display_name,
    status: row.status,
    defaultCurrency: row.default_currency,
    defaultLanguage: row.default_language,
    timezone: row.timezone,
    activatedAt: iso(row.activated_at),
    suspendedAt: iso(row.suspended_at),
    suspensionReason: row.suspension_reason,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    storeCount: Number(row.store_count || 0),
    userCount: Number(row.user_count || 0),
    ownerName: row.owner_name || null,
    ownerEmail: row.owner_email || null
  };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function listTenants({ search, status, page, pageSize, connection = getPrimaryPool() }) {
  const where = ["t.deleted_at IS NULL"];
  const parameters = [];

  if (search) {
    const term = `%${escapeLike(search)}%`;
    where.push("(t.display_name LIKE ? ESCAPE '\\\\' OR t.legal_name LIKE ? ESCAPE '\\\\' OR t.code LIKE ? ESCAPE '\\\\')");
    parameters.push(term, term, term);
  }

  if (status !== "ALL") {
    where.push("t.status = ?");
    parameters.push(status);
  }

  const clause = where.join(" AND ");
  const offset = (page - 1) * pageSize;
  const [countRows] = await connection.execute(
    `SELECT COUNT(*) AS total FROM tenants t WHERE ${clause}`,
    parameters
  );
  const [rows] = await connection.execute(
    `SELECT t.id, t.code, t.legal_name, t.display_name, t.status,
            t.default_currency, t.default_language, t.timezone,
            t.activated_at, t.suspended_at, t.suspension_reason,
            t.created_at, t.updated_at,
            (SELECT COUNT(*) FROM stores s
              WHERE s.tenant_id = t.id AND s.deleted_at IS NULL) AS store_count,
            (SELECT COUNT(*) FROM tenant_memberships tm
              WHERE tm.tenant_id = t.id AND tm.status = 'ACTIVE') AS user_count,
            (SELECT CONCAT(u.first_name, IF(u.last_name IS NULL OR u.last_name = '', '', CONCAT(' ', u.last_name)))
               FROM tenant_memberships own
               JOIN users u ON u.id = own.user_id
              WHERE own.tenant_id = t.id AND own.membership_type = 'OWNER'
              ORDER BY own.created_at LIMIT 1) AS owner_name,
            (SELECT u.email
               FROM tenant_memberships own
               JOIN users u ON u.id = own.user_id
              WHERE own.tenant_id = t.id AND own.membership_type = 'OWNER'
              ORDER BY own.created_at LIMIT 1) AS owner_email
       FROM tenants t
      WHERE ${clause}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ? OFFSET ?`,
    [...parameters, pageSize, offset]
  );

  return { items: rows.map(mapTenant), total: Number(countRows[0].total) };
}

export async function summarizeTenants({ connection = getPrimaryPool() } = {}) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS total,
            SUM(status = 'ACTIVE') AS active,
            SUM(status = 'PENDING') AS pending,
            SUM(status = 'SUSPENDED') AS suspended
       FROM tenants
      WHERE deleted_at IS NULL`
  );
  const row = rows[0];
  return {
    total: Number(row.total || 0),
    active: Number(row.active || 0),
    pending: Number(row.pending || 0),
    suspended: Number(row.suspended || 0)
  };
}

export async function findTenantByCode({ code, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    "SELECT id FROM tenants WHERE code = ? AND deleted_at IS NULL LIMIT 1",
    [code]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id) } : null;
}

export async function findTenantById({ tenantId, connection = getPrimaryPool(), forUpdate = false }) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.execute(
    `SELECT id, code, legal_name, display_name, status, default_currency,
            default_language, timezone, activated_at, suspended_at,
            suspension_reason, created_at, updated_at
       FROM tenants
      WHERE id = ? AND deleted_at IS NULL
      LIMIT 1${lock}`,
    [uuidToBuffer(tenantId)]
  );
  return mapTenant(rows[0]);
}

export async function listTenantProductVerticals({ tenantId, connection = getPrimaryPool(), forUpdate = false }) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.execute(
    `SELECT vertical FROM tenant_product_verticals
      WHERE tenant_id = ? AND status = 'ACTIVE'
      ORDER BY FIELD(vertical, 'GENERAL', 'GROCERY', 'ELECTRONICS', 'CLOTHING'), vertical${lock}`,
    [uuidToBuffer(tenantId)]
  );
  return rows.map((row) => row.vertical);
}

export async function insertTenantProductVerticals({ tenantId, verticals, enabledBy, connection }) {
  for (const vertical of verticals) {
    await connection.execute(
      `INSERT INTO tenant_product_verticals (tenant_id, vertical, status, enabled_by)
       VALUES (?, ?, 'ACTIVE', ?)
       ON DUPLICATE KEY UPDATE status = 'ACTIVE', enabled_by = VALUES(enabled_by), updated_at = UTC_TIMESTAMP(6)`,
      [uuidToBuffer(tenantId), vertical, uuidToBuffer(enabledBy)]
    );
  }
}

export async function replaceTenantProductVerticals({ tenantId, verticals, enabledBy, connection }) {
  await connection.execute(
    "UPDATE tenant_product_verticals SET status = 'INACTIVE', updated_at = UTC_TIMESTAMP(6) WHERE tenant_id = ?",
    [uuidToBuffer(tenantId)]
  );
  await insertTenantProductVerticals({ tenantId, verticals, enabledBy, connection });
}

export async function countProductsByVerticals({ tenantId, verticals, connection }) {
  if (!verticals.length) return [];
  const placeholders = verticals.map(() => "?").join(", ");
  const [rows] = await connection.execute(
    `SELECT pt.vertical, COUNT(*) AS product_count
       FROM products p
       JOIN product_types pt ON pt.id = p.product_type_id
      WHERE p.tenant_id = ? AND pt.vertical IN (${placeholders})
      GROUP BY pt.vertical`,
    [uuidToBuffer(tenantId), ...verticals]
  );
  return rows.map((row) => ({ vertical: row.vertical, productCount: Number(row.product_count) }));
}

export async function findUserByEmail({ email, connection }) {
  const [rows] = await connection.execute(
    `SELECT id, email, first_name, last_name, status
       FROM users
      WHERE email = ? AND deleted_at IS NULL
      LIMIT 1`,
    [email]
  );
  if (!rows[0]) {
    return null;
  }
  return {
    id: bufferToUuid(rows[0].id),
    email: rows[0].email,
    firstName: rows[0].first_name,
    lastName: rows[0].last_name,
    status: rows[0].status
  };
}

export async function listTenantStores({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT s.id, s.code, s.name, s.legal_name, s.status, s.base_currency,
            s.language_code, s.timezone, s.support_email, s.support_phone,
            s.created_at,
            (SELECT COUNT(*) FROM sales_channels c
              WHERE c.tenant_id = s.tenant_id AND c.store_id = s.id AND c.status = 'ACTIVE') AS channel_count
       FROM stores s
      WHERE s.tenant_id = ? AND s.deleted_at IS NULL
      ORDER BY s.created_at, s.name`,
    [uuidToBuffer(tenantId)]
  );
  return rows.map((row) => ({
    id: bufferToUuid(row.id),
    code: row.code,
    name: row.name,
    legalName: row.legal_name,
    status: row.status,
    baseCurrency: row.base_currency,
    languageCode: row.language_code,
    timezone: row.timezone,
    supportEmail: row.support_email,
    supportPhone: row.support_phone,
    channelCount: Number(row.channel_count || 0),
    createdAt: iso(row.created_at)
  }));
}

export async function listTenantMerchants({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT id, merchant_code, merchant_type, display_name, legal_name,
            status, support_email, support_phone, created_at
       FROM merchants
      WHERE tenant_id = ? AND deleted_at IS NULL
      ORDER BY merchant_type, created_at`,
    [uuidToBuffer(tenantId)]
  );
  return rows.map((row) => ({
    id: bufferToUuid(row.id),
    code: row.merchant_code,
    type: row.merchant_type,
    displayName: row.display_name,
    legalName: row.legal_name,
    status: row.status,
    supportEmail: row.support_email,
    supportPhone: row.support_phone,
    createdAt: iso(row.created_at)
  }));
}

export async function findTenantOwner({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.status,
            tm.status AS membership_status, tm.joined_at
       FROM tenant_memberships tm
       JOIN users u ON u.id = tm.user_id
      WHERE tm.tenant_id = ?
        AND tm.membership_type = 'OWNER'
        AND u.deleted_at IS NULL
      ORDER BY tm.created_at
      LIMIT 1`,
    [uuidToBuffer(tenantId)]
  );
  if (!rows[0]) {
    return null;
  }
  const row = rows[0];
  return {
    id: bufferToUuid(row.id),
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    status: row.status,
    membershipStatus: row.membership_status,
    joinedAt: iso(row.joined_at)
  };
}

export async function listTenantAudit({ tenantId, limit = 20, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata,
            a.occurred_at, u.first_name, u.last_name, u.email
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.tenant_id = ?
      ORDER BY a.occurred_at DESC
      LIMIT ?`,
    [uuidToBuffer(tenantId), limit]
  );
  return rows.map((row) => ({
    id: bufferToUuid(row.id),
    action: row.action,
    entityType: row.entity_type,
    entityId: bufferToUuid(row.entity_id),
    metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
    occurredAt: iso(row.occurred_at),
    actor: row.email ? {
      name: [row.first_name, row.last_name].filter(Boolean).join(" "),
      email: row.email
    } : null
  }));
}

export async function insertTenant({ tenant, connection }) {
  await connection.execute(
    `INSERT INTO tenants (
       id, code, legal_name, display_name, status,
       default_currency, default_language, timezone
     ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
    [
      uuidToBuffer(tenant.id), tenant.code, tenant.legalName, tenant.displayName,
      tenant.defaultCurrency, tenant.defaultLanguage, tenant.timezone
    ]
  );
}

export async function insertUser({ user, connection }) {
  await connection.execute(
    `INSERT INTO users (
       id, email, password_hash, first_name, last_name, status,
       email_verified_at, password_changed_at
     ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
    [uuidToBuffer(user.id), user.email, user.passwordHash, user.firstName, user.lastName || null]
  );
}

export async function insertStore({ store, connection }) {
  await connection.execute(
    `INSERT INTO stores (
       id, tenant_id, code, name, legal_name, status, base_currency,
       language_code, timezone, support_email, support_phone
     ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(store.id), uuidToBuffer(store.tenantId), store.code, store.name,
      store.legalName, store.baseCurrency, store.languageCode, store.timezone,
      store.supportEmail, store.supportPhone
    ]
  );
}

export async function insertSalesChannel({ channel, connection }) {
  await connection.execute(
    `INSERT INTO sales_channels (
       id, tenant_id, store_id, code, name, channel_type, status, configuration
     ) VALUES (?, ?, ?, ?, ?, 'ADMIN', 'ACTIVE', ?)`,
    [
      uuidToBuffer(channel.id), uuidToBuffer(channel.tenantId), uuidToBuffer(channel.storeId),
      channel.code, channel.name, JSON.stringify(channel.configuration || {})
    ]
  );
}

export async function insertMerchant({ merchant, connection }) {
  await connection.execute(
    `INSERT INTO merchants (
       id, tenant_id, merchant_code, merchant_type, display_name, legal_name,
       status, support_email, support_phone, approved_at, approved_by
     ) VALUES (?, ?, ?, 'FIRST_PARTY', ?, ?, 'ACTIVE', ?, ?, UTC_TIMESTAMP(6), ?)`,
    [
      uuidToBuffer(merchant.id), uuidToBuffer(merchant.tenantId), merchant.code,
      merchant.displayName, merchant.legalName, merchant.supportEmail, merchant.supportPhone,
      uuidToBuffer(merchant.approvedBy)
    ]
  );
}

export async function linkStoreMerchant({ storeId, merchantId, connection }) {
  await connection.execute(
    "INSERT INTO store_merchants (store_id, merchant_id, status) VALUES (?, ?, 'ACTIVE')",
    [uuidToBuffer(storeId), uuidToBuffer(merchantId)]
  );
}

export async function insertRole({ role, connection }) {
  await connection.execute(
    `INSERT INTO roles (id, tenant_id, role_key, name, role_level, is_system)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [uuidToBuffer(role.id), uuidToBuffer(role.tenantId), role.key, role.name, role.level]
  );
}

export async function insertRolePermissions({ roleId, permissionKeys, connection }) {
  if (permissionKeys === "ALL") {
    await connection.execute(
      `INSERT IGNORE INTO role_permissions (role_id, permission_id)
       SELECT ?, id FROM permissions WHERE permission_key NOT LIKE 'platform.%'`,
      [uuidToBuffer(roleId)]
    );
    return;
  }
  if (!permissionKeys.length) return;
  const placeholders = permissionKeys.map(() => "?").join(", ");
  await connection.execute(
    `INSERT IGNORE INTO role_permissions (role_id, permission_id)
     SELECT ?, id FROM permissions WHERE permission_key IN (${placeholders})`,
    [uuidToBuffer(roleId), ...permissionKeys]
  );
}

export async function insertMembership({ membership, connection }) {
  await connection.execute(
    `INSERT INTO tenant_memberships (
       id, tenant_id, user_id, membership_type, status, invited_by,
       invited_at, joined_at
     ) VALUES (?, ?, ?, 'OWNER', 'ACTIVE', ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
    [
      uuidToBuffer(membership.id), uuidToBuffer(membership.tenantId),
      uuidToBuffer(membership.userId), uuidToBuffer(membership.invitedBy)
    ]
  );
}

export async function insertRoleAssignment({ assignment, connection }) {
  await connection.execute(
    `INSERT INTO user_role_assignments (
       id, user_id, tenant_id, role_id, scope_type, scope_id, assigned_by
     ) VALUES (?, ?, ?, ?, 'TENANT', ?, ?)`,
    [
      uuidToBuffer(assignment.id), uuidToBuffer(assignment.userId),
      uuidToBuffer(assignment.tenantId), uuidToBuffer(assignment.roleId),
      uuidToBuffer(assignment.tenantId), uuidToBuffer(assignment.assignedBy)
    ]
  );
}

export async function insertNumberSequence({ sequence, connection }) {
  await connection.execute(
    `INSERT INTO number_sequences (
       id, tenant_id, store_id, sequence_type, financial_year,
       prefix, next_number, number_padding
     ) VALUES (?, ?, ?, ?, NULL, ?, 1, 6)`,
    [
      uuidToBuffer(sequence.id), uuidToBuffer(sequence.tenantId),
      uuidToBuffer(sequence.storeId), sequence.type, sequence.prefix
    ]
  );
}

export async function insertAuditLog({ audit, connection }) {
  await connection.execute(
    `INSERT INTO audit_logs (
       id, tenant_id, actor_user_id, actor_type, action, entity_type,
       entity_id, request_id, ip_address, user_agent, before_data,
       after_data, metadata
     ) VALUES (?, ?, ?, 'USER', ?, 'TENANT', ?, ?, INET6_ATON(?), ?, ?, ?, ?)`,
    [
      uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId),
      audit.action, uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress,
      audit.userAgent, audit.beforeData ? JSON.stringify(audit.beforeData) : null,
      audit.afterData ? JSON.stringify(audit.afterData) : null,
      audit.metadata ? JSON.stringify(audit.metadata) : null
    ]
  );
}

export async function insertOutboxEvent({ event, connection }) {
  await connection.execute(
    `INSERT INTO outbox_events (
       id, tenant_id, aggregate_type, aggregate_id, event_type, payload
     ) VALUES (?, ?, 'TENANT', ?, ?, ?)`,
    [
      uuidToBuffer(event.id), uuidToBuffer(event.tenantId), uuidToBuffer(event.aggregateId),
      event.type, JSON.stringify(event.payload)
    ]
  );
}

export async function updateTenantDetails({ tenantId, changes, connection }) {
  const assignments = [];
  const parameters = [];
  const columns = {
    legalName: "legal_name",
    displayName: "display_name",
    timezone: "timezone"
  };

  for (const [key, column] of Object.entries(columns)) {
    if (changes[key] !== undefined) {
      assignments.push(`${column} = ?`);
      parameters.push(changes[key]);
    }
  }

  if (!assignments.length) return;
  parameters.push(uuidToBuffer(tenantId));
  await connection.execute(
    `UPDATE tenants SET ${assignments.join(", ")} WHERE id = ? AND deleted_at IS NULL`,
    parameters
  );
}

export async function updateTenantStatus({ tenantId, status, reason, connection }) {
  const dates = status === "ACTIVE"
    ? "activated_at = UTC_TIMESTAMP(6), suspended_at = NULL"
    : "suspended_at = UTC_TIMESTAMP(6)";
  const suspensionReason = status === "SUSPENDED" ? reason : null;
  await connection.execute(
    `UPDATE tenants
        SET status = ?, ${dates}, suspension_reason = ?
      WHERE id = ? AND deleted_at IS NULL`,
    [status, suspensionReason, uuidToBuffer(tenantId)]
  );
}
