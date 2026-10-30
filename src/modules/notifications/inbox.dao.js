import { getPrimaryPool } from "../../database/pool-factory.js";
import { stockSourceJoins, stockSourceEligible } from "./stock-alerts.dao.js";
import { createId, uuidToBuffer as id, bufferToUuid as uuid } from "../../core/identifiers/uuid.js";

const iso = (value) => value instanceof Date ? value.toISOString() : value;
const decode = (value) => typeof value === "string" ? JSON.parse(value) : value;

export async function activeSession({ userId, sessionId, connection = getPrimaryPool() }) {
  const [[row]] = await connection.execute(`SELECT s.id FROM user_sessions s
    JOIN users u ON u.id = s.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
    WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(6)`, [id(sessionId), id(userId)]);
  return Boolean(row);
}

export async function staffRecipients({ tenantId, merchantId = null, permission, connection }) {
  const vendor = Boolean(merchantId);
  const [rows] = await connection.execute(`SELECT DISTINCT a.user_id FROM user_role_assignments a
    JOIN users u ON u.id = a.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
    JOIN tenant_memberships tm ON tm.user_id = a.user_id AND tm.tenant_id = a.tenant_id AND tm.status = 'ACTIVE'
    JOIN tenants t ON t.id = a.tenant_id AND t.status = 'ACTIVE' AND t.deleted_at IS NULL
    JOIN roles r ON r.id = a.role_id AND r.deleted_at IS NULL AND r.role_level = ?
    JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id
    WHERE a.tenant_id = ? AND a.revoked_at IS NULL AND a.scope_type = ? AND a.scope_id = ?
      AND p.permission_key = ?`, [vendor ? "VENDOR" : "TENANT", id(tenantId), vendor ? "MERCHANT" : "TENANT", id(merchantId || tenantId), permission]);
  return rows.map((r) => uuid(r.user_id));
}

export async function sourceOrder({ tenantId, orderId, connection }) {
  const [[r]] = await connection.execute(`SELECT o.id, o.store_id, o.customer_id,
    EXISTS(SELECT 1 FROM customer_accounts ca JOIN customers c ON c.id = ca.customer_id AND c.tenant_id = ca.tenant_id
      WHERE ca.tenant_id = o.tenant_id AND ca.customer_id = o.customer_id AND ca.verified_at IS NOT NULL
        AND c.status = 'ACTIVE' AND c.deleted_at IS NULL) AS eligible_customer
    FROM customer_orders o JOIN tenants t ON t.id = o.tenant_id AND t.status = 'ACTIVE' AND t.deleted_at IS NULL
    JOIN stores s ON s.id = o.store_id AND s.tenant_id = o.tenant_id AND s.status = 'ACTIVE' AND s.deleted_at IS NULL
    WHERE o.tenant_id = ? AND o.id = ?`, [id(tenantId), id(orderId)]);
  return r ? { storeId: uuid(r.store_id), customerId: r.eligible_customer ? uuid(r.customer_id) : null } : null;
}

export async function orderVendors({ tenantId, orderId, connection }) {
  const [rows] = await connection.execute(`SELECT so.id, so.merchant_id FROM seller_orders so
    JOIN merchants m ON m.id = so.merchant_id AND m.tenant_id = so.tenant_id AND m.status = 'ACTIVE' AND m.deleted_at IS NULL
    JOIN vendor_profiles vp ON vp.merchant_id = m.id AND vp.tenant_id = m.tenant_id AND vp.onboarding_status = 'APPROVED'
    WHERE so.tenant_id = ? AND so.customer_order_id = ? AND m.merchant_type = 'VENDOR'`, [id(tenantId), id(orderId)]);
  return rows.map((r) => ({ sellerOrderId: uuid(r.id), merchantId: uuid(r.merchant_id) }));
}

export async function sourceReturn({ tenantId, returnId, connection }) {
  const [[r]] = await connection.execute("SELECT customer_order_id FROM return_requests WHERE tenant_id = ? AND id = ?", [id(tenantId), id(returnId)]);
  return r ? uuid(r.customer_order_id) : null;
}

export async function enqueue({ event, connection }) {
  if (!event.recipients.length) return;
  await connection.execute(`INSERT INTO inbox_events
    (id, tenant_id, event_key, audience, store_id, merchant_id, kind, category, entity_type, entity_id,
     order_id, required_permission, title, message, recipients)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE id = id`, [id(createId()), id(event.tenantId), event.key, event.audience,
    event.storeId ? id(event.storeId) : null, event.merchantId ? id(event.merchantId) : null,
    event.kind, event.category, event.entityType, id(event.entityId), event.orderId ? id(event.orderId) : null,
    event.permission || null, event.title, event.message, JSON.stringify([...new Set(event.recipients)])]);
}

// All list/count/read mutations use the same ownership and current-authorisation predicate.
function visibility(scope) {
  const where = ["n.recipient_id = ?", "n.tenant_id = e.tenant_id", "e.audience = ?"];
  const args = [id(scope.recipientId), scope.audience];
  if (scope.audience !== "PLATFORM") { where.push("n.tenant_id = ?"); args.push(id(scope.tenantId)); }
  if (scope.audience === "CUSTOMER") {
    where.push(`e.store_id = ? AND EXISTS (SELECT 1 FROM customer_orders o WHERE o.id = e.order_id
      AND o.tenant_id = n.tenant_id AND o.store_id = e.store_id AND o.customer_id = n.recipient_id)`);
    args.push(id(scope.storeId));
  } else if (!scope.unrestricted) {
    const permissions = scope.permissions || [];
    where.push(permissions.length ? `e.required_permission IN (${permissions.map(() => "?").join(",")})` : "1 = 0");
    args.push(...permissions);
  }
  if (scope.audience === "VENDOR") {
    where.push(`e.merchant_id = ? AND EXISTS (SELECT 1 FROM seller_orders so
      JOIN merchants m ON m.id = so.merchant_id AND m.tenant_id = so.tenant_id
      JOIN vendor_profiles vp ON vp.merchant_id = m.id AND vp.tenant_id = m.tenant_id
      WHERE so.id = e.entity_id AND so.tenant_id = n.tenant_id AND so.merchant_id = e.merchant_id
        AND m.status = 'ACTIVE' AND m.deleted_at IS NULL AND vp.onboarding_status = 'APPROVED')`);
    args.push(id(scope.merchantId));
  }
  // Never expose a notification whose source was removed or moved to another scope.
  where.push(`(e.entity_type NOT IN ('ORDER','SELLER_ORDER','RETURN','WARRANTY_CLAIM') OR EXISTS
    (SELECT 1 FROM customer_orders source WHERE source.id = e.order_id AND source.tenant_id = e.tenant_id AND source.store_id = e.store_id))`);
  where.push(`(e.entity_type <> 'RETURN' OR EXISTS (SELECT 1 FROM return_requests rr
    WHERE rr.id = e.entity_id AND rr.tenant_id = e.tenant_id AND rr.customer_order_id = e.order_id))`);
  where.push(`(e.entity_type <> 'INVENTORY_BALANCE' OR (e.audience = 'ADMIN' AND EXISTS
    (SELECT 1 FROM inventory_balances ib ${stockSourceJoins}
      WHERE ib.id = e.entity_id AND ib.tenant_id = e.tenant_id AND so.store_id = e.store_id
        AND ${stockSourceEligible})))`);
  where.push(`(e.entity_type <> 'WARRANTY_CLAIM' OR EXISTS
    (SELECT 1 FROM warranty_claims wc
      JOIN warranty_registrations wr ON wr.id = wc.warranty_registration_id AND wr.tenant_id = wc.tenant_id
      JOIN order_items oi ON oi.id = wr.order_item_id AND oi.tenant_id = wc.tenant_id
      WHERE wc.id = e.entity_id AND wc.tenant_id = e.tenant_id AND oi.customer_order_id = e.order_id
        AND (e.audience <> 'CUSTOMER' OR wr.customer_id = n.recipient_id)))`);
  where.push(`(e.entity_type <> 'BULK_IMPORT' OR (e.audience = 'ADMIN' AND EXISTS
    (SELECT 1 FROM bulk_import_jobs j WHERE j.id = e.entity_id AND j.tenant_id = e.tenant_id
      AND (j.created_by = n.recipient_id OR j.committed_by = n.recipient_id))))`);
  where.push(`(e.entity_type <> 'PRODUCT_APPROVAL' OR (? = 1 AND e.audience = 'ADMIN' AND EXISTS
    (SELECT 1 FROM products p WHERE p.id = e.entity_id AND p.tenant_id = e.tenant_id AND p.deleted_at IS NULL)))`);
  // Reviewers need both approve (required_permission) and read, including after role changes.
  args.push(scope.audience === "ADMIN" && (scope.permissions || []).includes("catalog.product.read") ? 1 : 0);
  where.push(`(e.entity_type <> 'VENDOR_APPROVAL' OR (? = 1 AND e.audience = 'ADMIN' AND EXISTS
    (SELECT 1 FROM merchants m JOIN vendor_profiles vp ON vp.merchant_id = m.id AND vp.tenant_id = m.tenant_id
      WHERE m.id = e.entity_id AND m.tenant_id = e.tenant_id AND m.merchant_type = 'VENDOR'
        AND m.deleted_at IS NULL)))`);
  // Review alerts require manage via required_permission and read via this shared visibility check.
  args.push(scope.audience === "ADMIN" && (scope.permissions || []).includes("vendor.read") ? 1 : 0);
  // Platform lifecycle history must remain visible for pending and suspended tenants.
  where.push(`(e.entity_type <> 'TENANT' OR (e.audience = 'PLATFORM' AND EXISTS
    (SELECT 1 FROM tenants t WHERE t.id = e.entity_id AND t.id = e.tenant_id AND t.deleted_at IS NULL)))`);
  return { sql: where.join(" AND "), args };
}

const from = "inbox_recipients n JOIN inbox_events e ON e.id = n.event_id";
export async function list({ scope, filter, page, pageSize, category = "ALL", search = "", connection = getPrimaryPool() }) {
  const v = visibility(scope), unread = filter === "UNREAD" ? " AND n.read_at IS NULL" : "";
  const [[counts]] = await connection.execute(`SELECT COUNT(*) AS total, COALESCE(SUM(n.read_at IS NULL),0) AS unread FROM ${from} WHERE ${v.sql}`, v.args);
  const selected = [], selectedArgs = [];
  if (category !== "ALL") { selected.push("e.category = ?"); selectedArgs.push(category); }
  if (search) { selected.push("(LOCATE(?, e.title) > 0 OR LOCATE(?, e.message) > 0)"); selectedArgs.push(search, search); }
  const narrowed = selected.length > 0;
  const selection = narrowed ? ` AND ${selected.join(" AND ")}` : "";
  let total = Number(filter === "UNREAD" ? counts.unread : counts.total);
  if (narrowed) {
    const [[matching]] = await connection.execute(`SELECT COUNT(*) AS total FROM ${from} WHERE ${v.sql}${unread}${selection}`, [...v.args, ...selectedArgs]);
    total = Number(matching.total);
  }
  const [rows] = await connection.execute(`SELECT n.id, n.read_at, n.created_at, e.kind, e.category,
    e.title, e.message, e.entity_type, e.entity_id, e.order_id, e.store_id, e.merchant_id
    FROM ${from} WHERE ${v.sql}${unread}${selection} ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`, [...v.args, ...selectedArgs, pageSize, (page - 1) * pageSize]);
  return { total, unreadCount: Number(counts.unread),
    readThroughId: !narrowed && page === 1 && rows.length ? uuid(rows[0].id) : null,
    items: rows.map((r) => ({ id: uuid(r.id), kind: r.kind, category: r.category, title: r.title, message: r.message,
      readAt: iso(r.read_at), createdAt: iso(r.created_at),
      target: { type: r.entity_type, id: uuid(r.entity_id), orderId: uuid(r.order_id), storeId: uuid(r.store_id), merchantId: uuid(r.merchant_id) } })) };
}

export async function unreadCount({ scope, connection = getPrimaryPool() }) {
  const v = visibility(scope);
  const [[r]] = await connection.execute(`SELECT COUNT(*) AS n FROM ${from} WHERE ${v.sql} AND n.read_at IS NULL`, v.args);
  return Number(r.n);
}

export async function markRead({ scope, notificationId, read, connection = getPrimaryPool() }) {
  const v = visibility(scope);
  // SELECT establishes ownership even when an idempotent UPDATE changes zero values.
  const [[owned]] = await connection.execute(`SELECT n.id FROM ${from} WHERE ${v.sql} AND n.id = ?`, [...v.args, id(notificationId)]);
  if (!owned) return false;
  await connection.execute(`UPDATE ${from} SET n.read_at = ${read ? "COALESCE(n.read_at,UTC_TIMESTAMP(6))" : "NULL"}
    WHERE ${v.sql} AND n.id = ?`, [...v.args, id(notificationId)]);
  return true;
}

export async function markAllRead({ scope, throughId, connection = getPrimaryPool() }) {
  const v = visibility(scope);
  const [[boundary]] = await connection.execute(`SELECT DATE_FORMAT(n.created_at,'%Y-%m-%d %H:%i:%s.%f') AS cutoff
    FROM ${from} WHERE ${v.sql} AND n.id = ?`, [...v.args, id(throughId)]);
  if (!boundary) return false;
  await connection.execute(`UPDATE ${from} SET n.read_at = UTC_TIMESTAMP(6) WHERE ${v.sql} AND n.read_at IS NULL
    AND (n.created_at < ? OR (n.created_at = ? AND n.id <= ?))`, [...v.args, boundary.cutoff, boundary.cutoff, id(throughId)]);
  return true;
}

// One short database transaction, no network I/O. FOR UPDATE works on MariaDB 10.4.
// A crashed worker rolls back both deliveries and progress. Uniqueness makes replay safe.
export async function processNext({ connection, eventId = null }) {
  const [[event]] = await connection.execute(`SELECT * FROM inbox_events WHERE status = 'QUEUED'
    AND next_attempt_at <= UTC_TIMESTAMP(6) ${eventId ? "AND id = ?" : ""}
    ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE`, eventId ? [id(eventId)] : []);
  if (!event) return null;
  await connection.query("SAVEPOINT inbox_delivery");
  try {
    const recipients = decode(event.recipients);
    if (!Array.isArray(recipients)) throw new Error("INVALID_RECIPIENTS");
    const batch = recipients.slice(event.recipient_offset, event.recipient_offset + 100);
    for (const recipientId of batch) {
      await connection.execute(`INSERT INTO inbox_recipients (id, tenant_id, event_id, recipient_id)
        VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id`, [id(createId()), event.tenant_id, event.id, id(recipientId)]);
    }
    const offset = event.recipient_offset + batch.length, complete = offset >= recipients.length;
    await connection.execute(`UPDATE inbox_events SET recipient_offset = ?, status = ?, attempt_count = 0,
      processed_at = IF(?,UTC_TIMESTAMP(6),NULL), last_error = NULL,
      last_delivery_progress_at = UTC_TIMESTAMP(6) WHERE id = ?`,
    [offset, complete ? "PROCESSED" : "QUEUED", complete, event.id]);
    return { id: uuid(event.id), status: complete ? "PROCESSED" : "QUEUED", delivered: batch.length };
  } catch {
    await connection.query("ROLLBACK TO SAVEPOINT inbox_delivery");
    const attempts = event.attempt_count + 1, status = attempts >= 5 ? "FAILED" : "QUEUED";
    await connection.execute(`UPDATE inbox_events SET attempt_count = ?, status = ?, last_error = 'INBOX_DELIVERY_FAILED',
      next_attempt_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND) WHERE id = ?`, [attempts, status, Math.min(3600, 30 * 2 ** attempts), event.id]);
    return { id: uuid(event.id), status, delivered: 0 };
  }
}

export async function summary(connection = getPrimaryPool()) {
  const [rows] = await connection.execute("SELECT status, COUNT(*) AS count FROM inbox_events GROUP BY status");
  return rows;
}

// Only an already-written, matching TEST capture can produce a payment alert.
export async function sourceTestCapture({ tenantId, attemptId, connection }) {
  const [[row]] = await connection.execute(`SELECT pa.order_id, pa.payment_id, o.status AS order_status
    FROM storefront_payment_attempts pa
    JOIN customer_orders o ON o.id = pa.order_id AND o.tenant_id = pa.tenant_id
      AND o.store_id = pa.store_id AND o.customer_id = pa.customer_id
    JOIN payments pay ON pay.id = pa.payment_id AND pay.tenant_id = pa.tenant_id
      AND pay.customer_order_id = pa.order_id
    WHERE pa.tenant_id = ? AND pa.id = ? AND pa.captured_payment_id IS NOT NULL
      AND o.payment_method = 'ONLINE_TEST' AND o.payment_status = 'PAID'
      AND pay.provider_code = 'RAZORPAY_TEST' AND pay.status = 'CAPTURED'
      AND pay.provider_reference = pa.captured_payment_id
      AND pay.captured_amount * 100 = pa.amount_minor
      AND EXISTS (SELECT 1 FROM payment_transactions pt
        WHERE pt.tenant_id = pa.tenant_id AND pt.payment_id = pa.payment_id
          AND pt.provider_transaction_id = pa.captured_payment_id
          AND pt.transaction_type = 'CAPTURE' AND pt.status = 'SUCCEEDED'
          AND pt.currency = 'INR' AND pt.amount * 100 = pa.amount_minor)`,
  [id(tenantId), id(attemptId)]);
  return row ? { orderId: uuid(row.order_id), paymentId: uuid(row.payment_id), orderStatus: row.order_status } : null;
}

export async function sourceWarrantyEvent({ tenantId, eventId, connection }) {
  const [[row]] = await connection.execute(`SELECT ce.event_type, ce.new_status, wc.id AS claim_id,
    wc.claim_number, wc.assigned_to, wr.customer_id, oi.customer_order_id
    FROM warranty_claim_events ce
    JOIN warranty_claims wc ON wc.id = ce.warranty_claim_id AND wc.tenant_id = ce.tenant_id
    JOIN warranty_registrations wr ON wr.id = wc.warranty_registration_id AND wr.tenant_id = ce.tenant_id
    JOIN order_items oi ON oi.id = wr.order_item_id AND oi.tenant_id = ce.tenant_id
    JOIN customer_orders co ON co.id = oi.customer_order_id AND co.tenant_id = ce.tenant_id
    WHERE ce.tenant_id = ? AND ce.id = ? AND wc.status = ce.new_status`, [id(tenantId), id(eventId)]);
  return row ? { type: row.event_type, status: row.new_status, claimId: uuid(row.claim_id),
    number: row.claim_number, assignedTo: uuid(row.assigned_to), customerId: uuid(row.customer_id),
    orderId: uuid(row.customer_order_id) } : null;
}

export async function sourceBulkImport({ tenantId, jobId, connection }) {
  const [[row]] = await connection.execute(`SELECT j.import_type, j.status, j.total_rows, j.valid_rows,
    j.invalid_rows, j.committed_rows, j.failed_rows, j.created_by, j.committed_by
    FROM bulk_import_jobs j
    JOIN tenants t ON t.id = j.tenant_id AND t.status = 'ACTIVE' AND t.deleted_at IS NULL
    WHERE j.tenant_id = ? AND j.id = ?`, [id(tenantId), id(jobId)]);
  return row ? { type: row.import_type, status: row.status, total: Number(row.total_rows),
    valid: Number(row.valid_rows), invalid: Number(row.invalid_rows),
    committed: Number(row.committed_rows), failed: Number(row.failed_rows),
    createdBy: uuid(row.created_by), committedBy: uuid(row.committed_by) } : null;
}

// Called immediately after the workflow audit write, with the product row locked by its transaction.
export async function sourceProductApproval({ tenantId, auditId, connection }) {
  const [[row]] = await connection.execute(`SELECT a.action, a.entity_id AS product_id,
    p.product_code, p.approval_status,
    (SELECT submitted.actor_user_id FROM audit_logs submitted
      WHERE submitted.tenant_id = a.tenant_id AND submitted.entity_type = 'PRODUCT'
        AND submitted.entity_id = a.entity_id AND submitted.actor_type = 'USER'
        AND submitted.action = 'catalog.product.submitted'
        AND (submitted.occurred_at < a.occurred_at
          OR (submitted.occurred_at = a.occurred_at AND submitted.id <= a.id))
      ORDER BY submitted.occurred_at DESC, submitted.id DESC LIMIT 1) AS submitted_by
    FROM audit_logs a
    JOIN products p ON p.id = a.entity_id AND p.tenant_id = a.tenant_id AND p.deleted_at IS NULL
    JOIN tenants t ON t.id = a.tenant_id AND t.status = 'ACTIVE' AND t.deleted_at IS NULL
    WHERE a.tenant_id = ? AND a.id = ? AND a.entity_type = 'PRODUCT' AND a.actor_type = 'USER'
      AND a.action IN ('catalog.product.submitted','catalog.product.approved','catalog.product.rejected')
      AND p.publication_status = 'DRAFT'
      AND p.approval_status = JSON_UNQUOTE(JSON_EXTRACT(a.after_data, '$.approvalStatus'))`,
    [id(tenantId), id(auditId)]);
  return row ? { action: row.action, productId: uuid(row.product_id), productCode: row.product_code,
    status: row.approval_status, submittedBy: uuid(row.submitted_by) } : null;
}

// The vendor service writes this audit inside its create/locked-decision transaction.
export async function sourceVendorApproval({ tenantId, auditId, connection }) {
  const [[row]] = await connection.execute(`SELECT a.action, m.id AS vendor_id, m.merchant_code,
    m.status, vp.onboarding_status,
    (SELECT created.actor_user_id FROM audit_logs created
      WHERE created.tenant_id = a.tenant_id AND created.entity_type = 'VENDOR'
        AND created.entity_id = a.entity_id AND created.actor_type = 'USER'
        AND created.action = 'vendor.created'
        AND (created.occurred_at < a.occurred_at
          OR (created.occurred_at = a.occurred_at AND created.id <= a.id))
      ORDER BY created.occurred_at ASC, created.id ASC LIMIT 1) AS created_by
    FROM audit_logs a
    JOIN merchants m ON m.id = a.entity_id AND m.tenant_id = a.tenant_id
      AND m.merchant_type = 'VENDOR' AND m.deleted_at IS NULL
    JOIN vendor_profiles vp ON vp.merchant_id = m.id AND vp.tenant_id = m.tenant_id
    JOIN tenants t ON t.id = a.tenant_id AND t.status = 'ACTIVE' AND t.deleted_at IS NULL
    WHERE a.tenant_id = ? AND a.id = ? AND a.entity_type = 'VENDOR' AND a.actor_type = 'USER'
      AND a.action IN ('vendor.created','vendor.approved')
      AND m.status = JSON_UNQUOTE(JSON_EXTRACT(a.after_data, '$.status'))
      AND (a.action <> 'vendor.approved' OR JSON_UNQUOTE(JSON_EXTRACT(a.before_data, '$.status')) = 'PENDING')`,
    [id(tenantId), id(auditId)]);
  return row ? { action: row.action, vendorId: uuid(row.vendor_id), merchantCode: row.merchant_code,
    status: row.status, onboardingStatus: row.onboarding_status, createdBy: uuid(row.created_by) } : null;
}

export async function platformRecipients({ permission, connection }) {
  const [rows] = await connection.execute(`SELECT DISTINCT a.user_id
    FROM user_role_assignments a
    JOIN platform_memberships pm ON pm.user_id = a.user_id AND pm.status = 'ACTIVE'
    JOIN users u ON u.id = a.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
    JOIN roles r ON r.id = a.role_id AND r.role_level = 'PLATFORM'
      AND r.tenant_id IS NULL AND r.deleted_at IS NULL
    WHERE a.tenant_id IS NULL AND a.scope_type = 'PLATFORM' AND a.revoked_at IS NULL
      AND (r.role_key = 'platform_super_admin' OR EXISTS
        (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = r.id AND p.permission_key = ?))`, [permission]);
  return rows.map(row => uuid(row.user_id));
}

// No ACTIVE-tenant filter: creation and suspension are themselves platform events.
export async function sourcePlatformTenantEvent({ tenantId, auditId, connection }) {
  const [[row]] = await connection.execute(`SELECT a.action, t.code, t.status,
    JSON_UNQUOTE(JSON_EXTRACT(a.before_data, '$.status')) AS previous_status
    FROM audit_logs a JOIN tenants t ON t.id = a.tenant_id AND t.id = a.entity_id AND t.deleted_at IS NULL
    WHERE a.tenant_id = ? AND a.id = ? AND a.entity_type = 'TENANT' AND a.actor_type = 'USER'
      AND a.action IN ('platform.tenant.created','platform.tenant.activated',
        'platform.tenant.suspended','platform.tenant.restored')
      AND t.status = JSON_UNQUOTE(JSON_EXTRACT(a.after_data, '$.status'))`,
    [id(tenantId), id(auditId)]);
  return row ? { action: row.action, code: row.code, status: row.status,
    previousStatus: row.previous_status } : null;
}
