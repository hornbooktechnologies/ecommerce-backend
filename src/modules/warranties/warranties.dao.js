import { enqueueWarrantyInbox } from "../notifications/warranty-inbox.events.js";
import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function date(value) {
  const normalized = iso(value);
  return normalized ? String(normalized).slice(0, 10) : null;
}

function number(value) {
  return Number(value || 0);
}

function like(value) {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function mapWarranty(row) {
  return {
    id: bufferToUuid(row.id),
    status: row.effective_status,
    storedStatus: row.status,
    warrantyType: row.warranty_type,
    startsAt: date(row.starts_at),
    endsAt: date(row.ends_at),
    productName: row.product_name,
    variantName: row.variant_name,
    sku: row.sku,
    serialId: bufferToUuid(row.serial_number_id),
    serialNumber: row.serial_number,
    serialStatus: row.serial_status,
    orderId: bufferToUuid(row.customer_order_id),
    orderNumber: row.order_number,
    customerId: bufferToUuid(row.customer_id),
    customerName: row.customer_name || "Guest customer",
    customerEmail: row.customer_email,
    claimCount: number(row.claim_count),
    openClaimCount: number(row.open_claim_count),
    createdAt: iso(row.created_at)
  };
}

function mapClaim(row) {
  return {
    id: bufferToUuid(row.id),
    number: row.claim_number,
    status: row.status,
    issueDescription: row.issue_description,
    diagnosisNotes: row.diagnosis_notes,
    resolutionType: row.resolution_type,
    resolutionNotes: row.resolution_notes,
    assignedTo: bufferToUuid(row.assigned_to),
    assignedToName: row.assigned_to_name,
    openedBy: bufferToUuid(row.opened_by),
    openedByName: row.opened_by_name,
    openedAt: iso(row.opened_at),
    diagnosedAt: iso(row.diagnosed_at),
    resolvedAt: iso(row.resolved_at),
    closedAt: iso(row.closed_at),
    updatedAt: iso(row.updated_at),
    warrantyId: bufferToUuid(row.warranty_registration_id),
    warrantyStatus: row.warranty_status,
    warrantyType: row.warranty_type,
    warrantyStartsAt: date(row.starts_at),
    warrantyEndsAt: date(row.ends_at),
    productName: row.product_name,
    variantName: row.variant_name,
    sku: row.sku,
    serialNumber: row.serial_number,
    serialStatus: row.serial_status,
    orderNumber: row.order_number,
    customerName: row.customer_name || "Guest customer",
    customerEmail: row.customer_email
  };
}

const warrantySelect = `
  SELECT wr.id, wr.status, wr.warranty_type, wr.starts_at, wr.ends_at, wr.created_at,
         CASE WHEN wr.status = 'ACTIVE' AND wr.ends_at < UTC_DATE() THEN 'EXPIRED' ELSE wr.status END AS effective_status,
         oi.customer_order_id, oi.product_name, oi.variant_name, oi.sku,
         sn.id AS serial_number_id, sn.serial_number, sn.status AS serial_status,
         co.order_number, wr.customer_id,
         TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_name, c.email AS customer_email,
         (SELECT COUNT(*) FROM warranty_claims wc WHERE wc.warranty_registration_id = wr.id) AS claim_count,
         (SELECT COUNT(*) FROM warranty_claims wc WHERE wc.warranty_registration_id = wr.id
           AND wc.status <> 'CLOSED') AS open_claim_count
    FROM warranty_registrations wr
    JOIN order_items oi ON oi.id = wr.order_item_id
    JOIN customer_orders co ON co.id = oi.customer_order_id
    LEFT JOIN serial_numbers sn ON sn.id = wr.serial_number_id
    LEFT JOIN customers c ON c.id = wr.customer_id`;

const claimSelect = `
  SELECT wc.id, wc.claim_number, wc.status, wc.issue_description, wc.diagnosis_notes,
         wc.resolution_type, wc.resolution_notes, wc.assigned_to, wc.opened_by,
         wc.opened_at, wc.diagnosed_at, wc.resolved_at, wc.closed_at, wc.updated_at,
         TRIM(CONCAT_WS(' ', assignee.first_name, assignee.last_name)) AS assigned_to_name,
         TRIM(CONCAT_WS(' ', opener.first_name, opener.last_name)) AS opened_by_name,
         wr.id AS warranty_registration_id, wr.warranty_type, wr.starts_at, wr.ends_at,
         CASE WHEN wr.status = 'ACTIVE' AND wr.ends_at < UTC_DATE() THEN 'EXPIRED' ELSE wr.status END AS warranty_status,
         oi.product_name, oi.variant_name, oi.sku, sn.serial_number, sn.status AS serial_status,
         co.order_number, TRIM(CONCAT_WS(' ', c.first_name, c.last_name)) AS customer_name, c.email AS customer_email
    FROM warranty_claims wc
    JOIN warranty_registrations wr ON wr.id = wc.warranty_registration_id
    JOIN order_items oi ON oi.id = wr.order_item_id
    JOIN customer_orders co ON co.id = oi.customer_order_id
    LEFT JOIN serial_numbers sn ON sn.id = wr.serial_number_id
    LEFT JOIN customers c ON c.id = wr.customer_id
    LEFT JOIN users assignee ON assignee.id = wc.assigned_to
    LEFT JOIN users opener ON opener.id = wc.opened_by`;

export async function listWarrantyOptions({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT u.id, u.first_name, u.last_name, u.email
       FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id
      WHERE tm.tenant_id = ? AND tm.status = 'ACTIVE' AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
      ORDER BY u.first_name, u.last_name, u.email`, [uuidToBuffer(tenantId)]
  );
  return { assignees: rows.map((row) => ({ id: bufferToUuid(row.id),
    name: [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email, email: row.email })) };
}

export async function listWarranties({ tenantId, filters, connection = getPrimaryPool() }) {
  const where = ["wr.tenant_id = ?"];
  const parameters = [uuidToBuffer(tenantId)];
  if (filters.search) {
    const term = like(filters.search);
    where.push("(sn.serial_number LIKE ? ESCAPE '\\\\' OR oi.product_name LIKE ? ESCAPE '\\\\' OR oi.sku LIKE ? ESCAPE '\\\\' OR co.order_number LIKE ? ESCAPE '\\\\' OR c.email LIKE ? ESCAPE '\\\\')");
    parameters.push(term, term, term, term, term);
  }
  if (filters.status !== "ALL") {
    if (filters.status === "EXPIRED") where.push("wr.status = 'ACTIVE' AND wr.ends_at < UTC_DATE()");
    else if (filters.status === "ACTIVE") where.push("wr.status = 'ACTIVE' AND wr.ends_at >= UTC_DATE()");
    else { where.push("wr.status = ?"); parameters.push(filters.status); }
  }
  const clause = where.join(" AND ");
  const offset = (filters.page - 1) * filters.pageSize;
  const [countRows, summaryRows, rows] = await Promise.all([
    connection.execute(`SELECT COUNT(*) AS total FROM warranty_registrations wr
      JOIN order_items oi ON oi.id = wr.order_item_id JOIN customer_orders co ON co.id = oi.customer_order_id
      LEFT JOIN serial_numbers sn ON sn.id = wr.serial_number_id LEFT JOIN customers c ON c.id = wr.customer_id
      WHERE ${clause}`, parameters).then(([result]) => result),
    connection.execute(`SELECT COUNT(*) AS total,
      SUM(status = 'ACTIVE' AND ends_at >= UTC_DATE()) AS active,
      SUM(status = 'ACTIVE' AND ends_at < UTC_DATE()) AS expired,
      (SELECT COUNT(*) FROM warranty_claims wc WHERE wc.tenant_id = ? AND wc.status <> 'CLOSED') AS open_claims
      FROM warranty_registrations WHERE tenant_id = ?`, [uuidToBuffer(tenantId), uuidToBuffer(tenantId)]).then(([result]) => result),
    connection.execute(`${warrantySelect} WHERE ${clause} ORDER BY wr.created_at DESC LIMIT ? OFFSET ?`,
      [...parameters, filters.pageSize, offset]).then(([result]) => result)
  ]);
  const total = number(countRows[0].total);
  const summary = summaryRows[0];
  return { items: rows.map(mapWarranty), total, page: filters.page, pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)), summary: { total: number(summary.total),
      active: number(summary.active), expired: number(summary.expired), openClaims: number(summary.open_claims) } };
}

export async function getWarranty({ tenantId, warrantyId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`${warrantySelect} WHERE wr.tenant_id = ? AND wr.id = ? LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(warrantyId)]);
  if (!rows[0]) return null;
  const [claims] = await connection.execute(`${claimSelect} WHERE wc.tenant_id = ? AND wc.warranty_registration_id = ? ORDER BY wc.opened_at DESC`,
    [uuidToBuffer(tenantId), uuidToBuffer(warrantyId)]);
  return { warranty: mapWarranty(rows[0]), claims: claims.map(mapClaim) };
}

export async function listClaims({ tenantId, filters, connection = getPrimaryPool() }) {
  const where = ["wc.tenant_id = ?"];
  const parameters = [uuidToBuffer(tenantId)];
  if (filters.search) {
    const term = like(filters.search);
    where.push("(wc.claim_number LIKE ? ESCAPE '\\\\' OR sn.serial_number LIKE ? ESCAPE '\\\\' OR oi.product_name LIKE ? ESCAPE '\\\\' OR co.order_number LIKE ? ESCAPE '\\\\')");
    parameters.push(term, term, term, term);
  }
  if (filters.status !== "ALL") { where.push("wc.status = ?"); parameters.push(filters.status); }
  const clause = where.join(" AND ");
  const offset = (filters.page - 1) * filters.pageSize;
  const [countRows, summaryRows, rows] = await Promise.all([
    connection.execute(`SELECT COUNT(*) AS total FROM warranty_claims wc
      JOIN warranty_registrations wr ON wr.id = wc.warranty_registration_id
      JOIN order_items oi ON oi.id = wr.order_item_id JOIN customer_orders co ON co.id = oi.customer_order_id
      LEFT JOIN serial_numbers sn ON sn.id = wr.serial_number_id WHERE ${clause}`, parameters).then(([result]) => result),
    connection.execute(`SELECT COUNT(*) AS total, SUM(status IN ('OPEN','ASSIGNED')) AS awaiting_diagnosis,
      SUM(status = 'DIAGNOSED') AS diagnosed, SUM(status = 'RESOLVED') AS resolved,
      SUM(status = 'CLOSED') AS closed FROM warranty_claims WHERE tenant_id = ?`, [uuidToBuffer(tenantId)]).then(([result]) => result),
    connection.execute(`${claimSelect} WHERE ${clause} ORDER BY wc.opened_at DESC LIMIT ? OFFSET ?`,
      [...parameters, filters.pageSize, offset]).then(([result]) => result)
  ]);
  const total = number(countRows[0].total);
  const summary = summaryRows[0];
  return { items: rows.map(mapClaim), total, page: filters.page, pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)), summary: { total: number(summary.total),
      awaitingDiagnosis: number(summary.awaiting_diagnosis), diagnosed: number(summary.diagnosed),
      resolved: number(summary.resolved), closed: number(summary.closed) } };
}

export async function getClaim({ tenantId, claimId, connection = getPrimaryPool(), forUpdate = false }) {
  const lock = forUpdate ? " FOR UPDATE" : "";
  const [rows] = await connection.execute(`${claimSelect} WHERE wc.tenant_id = ? AND wc.id = ? LIMIT 1${lock}`,
    [uuidToBuffer(tenantId), uuidToBuffer(claimId)]);
  if (!rows[0]) return null;
  const [events] = await connection.execute(
    `SELECT e.id, e.event_type, e.previous_status, e.new_status, e.notes, e.metadata,
            e.created_at, TRIM(CONCAT_WS(' ', u.first_name, u.last_name)) AS created_by_name
       FROM warranty_claim_events e LEFT JOIN users u ON u.id = e.created_by
      WHERE e.tenant_id = ? AND e.warranty_claim_id = ? ORDER BY e.created_at, e.id`,
    [uuidToBuffer(tenantId), uuidToBuffer(claimId)]
  );
  return { claim: mapClaim(rows[0]), events: events.map((row) => ({ id: bufferToUuid(row.id),
    type: row.event_type, previousStatus: row.previous_status, newStatus: row.new_status,
    notes: row.notes, metadata: row.metadata, createdByName: row.created_by_name,
    createdAt: iso(row.created_at) })) };
}

export async function findWarrantyForClaim({ tenantId, warrantyId, connection }) {
  const [rows] = await connection.execute(
    `SELECT wr.id, wr.status,
            CASE WHEN wr.status = 'ACTIVE' AND wr.ends_at < UTC_DATE() THEN 'EXPIRED' ELSE wr.status END AS effective_status,
            wr.serial_number_id, sn.status AS serial_status, wr.ends_at,
            EXISTS(SELECT 1 FROM warranty_claims wc WHERE wc.warranty_registration_id = wr.id AND wc.status <> 'CLOSED') AS has_open_claim
       FROM warranty_registrations wr LEFT JOIN serial_numbers sn ON sn.id = wr.serial_number_id
      WHERE wr.tenant_id = ? AND wr.id = ? LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(warrantyId)]
  );
  if (!rows[0]) return null;
  return { id: bufferToUuid(rows[0].id), status: rows[0].effective_status,
    serialId: bufferToUuid(rows[0].serial_number_id), serialStatus: rows[0].serial_status,
    endsAt: date(rows[0].ends_at), hasOpenClaim: Boolean(rows[0].has_open_claim) };
}

export async function findAssignableUser({ tenantId, userId, connection }) {
  const [rows] = await connection.execute(
    `SELECT u.id FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id
      WHERE tm.tenant_id = ? AND tm.user_id = ? AND tm.status = 'ACTIVE'
        AND u.status = 'ACTIVE' AND u.deleted_at IS NULL LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(userId)]
  );
  return rows.length === 1;
}

export async function insertClaim({ claim, connection }) {
  await connection.execute(
    `INSERT INTO warranty_claims (id, tenant_id, warranty_registration_id, claim_number,
       status, issue_description, opened_by) VALUES (?, ?, ?, ?, 'OPEN', ?, ?)`,
    [uuidToBuffer(claim.id), uuidToBuffer(claim.tenantId), uuidToBuffer(claim.warrantyId),
      claim.number, claim.issueDescription, uuidToBuffer(claim.openedBy)]
  );
}

export async function assignClaim({ tenantId, claimId, assignedTo, connection }) {
  await connection.execute(
    `UPDATE warranty_claims SET assigned_to = ?, status = CASE WHEN status = 'OPEN' THEN 'ASSIGNED' ELSE status END
      WHERE tenant_id = ? AND id = ?`, [uuidToBuffer(assignedTo), uuidToBuffer(tenantId), uuidToBuffer(claimId)]
  );
}

export async function diagnoseClaim({ tenantId, claimId, diagnosisNotes, assignedTo, connection }) {
  await connection.execute(
    `UPDATE warranty_claims SET status = 'DIAGNOSED', diagnosis_notes = ?, diagnosed_at = UTC_TIMESTAMP(6),
       assigned_to = COALESCE(assigned_to, ?) WHERE tenant_id = ? AND id = ?`,
    [diagnosisNotes, uuidToBuffer(assignedTo), uuidToBuffer(tenantId), uuidToBuffer(claimId)]
  );
}

export async function resolveClaim({ tenantId, claimId, resolutionType, resolutionNotes, connection }) {
  await connection.execute(
    `UPDATE warranty_claims SET status = 'RESOLVED', resolution_type = ?, resolution_notes = ?,
       resolved_at = UTC_TIMESTAMP(6) WHERE tenant_id = ? AND id = ?`,
    [resolutionType, resolutionNotes, uuidToBuffer(tenantId), uuidToBuffer(claimId)]
  );
}

export async function closeClaim({ tenantId, claimId, connection }) {
  await connection.execute(
    `UPDATE warranty_claims SET status = 'CLOSED', closed_at = UTC_TIMESTAMP(6)
      WHERE tenant_id = ? AND id = ?`, [uuidToBuffer(tenantId), uuidToBuffer(claimId)]
  );
}

export async function insertClaimEvent({ event, connection }) {
  await connection.execute(
    `INSERT INTO warranty_claim_events (id, tenant_id, warranty_claim_id, event_type,
       previous_status, new_status, notes, metadata, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(event.id), uuidToBuffer(event.tenantId), uuidToBuffer(event.claimId), event.type,
      event.previousStatus || null, event.newStatus, event.notes || null,
      event.metadata ? JSON.stringify(event.metadata) : null, uuidToBuffer(event.createdBy)]
  );
  await enqueueWarrantyInbox({ tenantId: event.tenantId, eventId: event.id, connection });
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(
    `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type,
       entity_id, request_id, ip_address, user_agent, before_data, after_data)
     VALUES (?, ?, ?, 'USER', ?, 'WARRANTY_CLAIM', ?, ?, INET6_ATON(?), ?, ?, ?)`,
    [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId),
      audit.action, uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress,
      audit.userAgent, JSON.stringify(audit.beforeData), JSON.stringify(audit.afterData)]
  );
}
