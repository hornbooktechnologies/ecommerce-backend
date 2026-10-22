import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

const number = (value) => value === null || value === undefined ? null : Number(value);
const iso = (value) => value instanceof Date ? value.toISOString() : value;
const escapeSearch = (value) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

function mapRule(row) {
  return { id: bufferToUuid(row.id), scopeType: row.scope_type, scopeId: bufferToUuid(row.scope_id),
    merchantId: bufferToUuid(row.merchant_id), merchantName: row.merchant_name,
    storeId: bufferToUuid(row.store_id), storeName: row.store_name, commissionType: row.commission_type,
    commissionPercent: number(row.commission_rate) === null ? null : number(row.commission_rate) * 100,
    commissionAmount: number(row.commission_amount), minimumCommission: number(row.minimum_commission),
    maximumCommission: number(row.maximum_commission), appliesOn: row.applies_on, priority: Number(row.priority || 0),
    effectiveFrom: iso(row.effective_from), effectiveTo: iso(row.effective_to), status: row.status,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function mapEntry(row) {
  return { id: bufferToUuid(row.id), merchantId: bufferToUuid(row.merchant_id), merchantName: row.merchant_name,
    merchantCode: row.merchant_code, sellerOrderId: bufferToUuid(row.seller_order_id),
    sellerOrderNumber: row.seller_order_number, entryType: row.entry_type, direction: row.direction,
    currency: row.currency, amount: number(row.amount), balanceEffect: number(row.balance_effect),
    referenceType: row.reference_type, referenceId: bufferToUuid(row.reference_id), description: row.description,
    effectiveAt: iso(row.effective_at), availableAt: iso(row.available_at), settlementStatus: row.settlement_status,
    reversalOfEntryId: bufferToUuid(row.reversal_of_entry_id), createdAt: iso(row.created_at) };
}

const ruleSelect = `SELECT cr.*, m.display_name AS merchant_name, s.name AS store_name
  FROM commission_rules cr LEFT JOIN merchants m ON m.id = cr.merchant_id
  LEFT JOIN stores s ON s.id = cr.store_id`;

export async function getWorkspace({ tenantId, filters, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId); const where = ["ml.tenant_id = ?"]; const params = [tenant];
  if (filters.search) { const term = `%${escapeSearch(filters.search)}%`;
    where.push(`(m.display_name LIKE ? ESCAPE '\\\\' OR m.merchant_code LIKE ? ESCAPE '\\\\'
      OR so.seller_order_number LIKE ? ESCAPE '\\\\' OR ml.description LIKE ? ESCAPE '\\\\')`);
    params.push(term, term, term, term); }
  if (filters.merchantId) { where.push("ml.merchant_id = ?"); params.push(uuidToBuffer(filters.merchantId)); }
  if (filters.entryType !== "ALL") { where.push("ml.entry_type = ?"); params.push(filters.entryType); }
  if (filters.settlementStatus !== "ALL") { where.push("ml.settlement_status = ?"); params.push(filters.settlementStatus); }
  const clause = where.join(" AND "); const offset = (filters.page - 1) * filters.pageSize;
  const [entryResult, countResult, summaryResult, ruleResult, merchantResult, storeResult] = await Promise.all([
    connection.execute(`SELECT ml.*, m.display_name AS merchant_name, m.merchant_code,
      so.seller_order_number FROM merchant_ledger_entries ml JOIN merchants m ON m.id = ml.merchant_id
      LEFT JOIN seller_orders so ON so.id = ml.seller_order_id WHERE ${clause}
      ORDER BY ml.effective_at DESC, ml.created_at DESC LIMIT ? OFFSET ?`, [...params, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total FROM merchant_ledger_entries ml JOIN merchants m ON m.id = ml.merchant_id
      LEFT JOIN seller_orders so ON so.id = ml.seller_order_id WHERE ${clause}`, params),
    connection.execute(`SELECT COALESCE(SUM(balance_effect), 0) AS current_balance,
      COALESCE(SUM(CASE WHEN settlement_status = 'UNSETTLED' THEN balance_effect ELSE 0 END), 0) AS unsettled_balance,
      COALESCE(SUM(CASE WHEN entry_type = 'SALE_CREDIT' THEN amount ELSE 0 END), 0) AS gross_sales,
      COALESCE(SUM(CASE WHEN entry_type IN ('COMMISSION_DEBIT','COMMISSION_GST_DEBIT') THEN amount ELSE 0 END), 0) AS commission,
      COUNT(DISTINCT merchant_id) AS merchants FROM merchant_ledger_entries WHERE tenant_id = ?`, [tenant]),
    connection.execute(`${ruleSelect} WHERE cr.tenant_id = ? ORDER BY cr.status = 'ACTIVE' DESC,
      cr.priority DESC, cr.effective_from DESC`, [tenant]),
    connection.execute(`SELECT id, merchant_code, display_name, merchant_type, status FROM merchants
      WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY merchant_type, display_name`, [tenant]),
    connection.execute(`SELECT id, code, name, status FROM stores WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY name`, [tenant])
  ]);
  const total = Number(countResult[0][0].total || 0); const summary = summaryResult[0][0];
  return { entries: entryResult[0].map(mapEntry), rules: ruleResult[0].map(mapRule),
    merchants: merchantResult[0].map((row) => ({ id: bufferToUuid(row.id), code: row.merchant_code,
      name: row.display_name, type: row.merchant_type, status: row.status })),
    stores: storeResult[0].map((row) => ({ id: bufferToUuid(row.id), code: row.code, name: row.name, status: row.status })),
    summary: { currentBalance: number(summary.current_balance) || 0,
      unsettledBalance: number(summary.unsettled_balance) || 0, grossSales: number(summary.gross_sales) || 0,
      commission: number(summary.commission) || 0, merchants: Number(summary.merchants || 0) },
    total, page: filters.page, pageSize: filters.pageSize, totalPages: Math.max(1, Math.ceil(total / filters.pageSize)) };
}

export async function getRule({ tenantId, ruleId, connection = getPrimaryPool(), forUpdate = false }) {
  const [rows] = await connection.execute(`${ruleSelect} WHERE cr.tenant_id = ? AND cr.id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(ruleId)]);
  return rows[0] ? mapRule(rows[0]) : null;
}

export async function scopeExists({ tenantId, input, connection }) {
  if (input.scopeType === "GLOBAL") return true;
  const table = input.scopeType === "MERCHANT" ? "merchants" : "stores";
  const id = input.scopeType === "MERCHANT" ? input.merchantId : input.storeId;
  const [rows] = await connection.execute(`SELECT id FROM ${table} WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(id)]);
  return Boolean(rows[0]);
}

function ruleValues(rule) {
  const scopeId = rule.scopeType === "MERCHANT" ? rule.merchantId : rule.scopeType === "STORE" ? rule.storeId : null;
  return [rule.storeId ? uuidToBuffer(rule.storeId) : null, rule.merchantId ? uuidToBuffer(rule.merchantId) : null,
    rule.scopeType, scopeId ? uuidToBuffer(scopeId) : null, rule.commissionType,
    rule.commissionType === "PERCENTAGE" ? rule.commissionPercent / 100 : null,
    rule.commissionType === "FIXED" ? rule.commissionAmount : null, rule.minimumCommission, rule.maximumCommission,
    rule.appliesOn, rule.priority, rule.effectiveFrom, rule.effectiveTo, rule.status];
}

export async function insertRule({ rule, connection }) {
  await connection.execute(`INSERT INTO commission_rules (id, tenant_id, store_id, merchant_id, scope_type, scope_id,
    commission_type, commission_rate, commission_amount, minimum_commission, maximum_commission, applies_on, priority,
    effective_from, effective_to, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [uuidToBuffer(rule.id), uuidToBuffer(rule.tenantId), ...ruleValues(rule)]);
}

export async function updateRule({ ruleId, rule, connection }) {
  await connection.execute(`UPDATE commission_rules SET store_id = ?, merchant_id = ?, scope_type = ?, scope_id = ?,
    commission_type = ?, commission_rate = ?, commission_amount = ?, minimum_commission = ?, maximum_commission = ?,
    applies_on = ?, priority = ?, effective_from = ?, effective_to = ?, status = ? WHERE id = ?`,
  [...ruleValues(rule), uuidToBuffer(ruleId)]);
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action,
    entity_type, entity_id, request_id, ip_address, user_agent, before_data, after_data)
    VALUES (?, ?, ?, 'USER', ?, ?, ?, ?, INET6_ATON(?), ?, ?, ?)`,
  [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId), audit.action,
    audit.entityType || "COMMISSION_RULE", uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress, audit.userAgent,
    JSON.stringify(audit.beforeData), JSON.stringify(audit.afterData)]);
}

export async function listCompletedSellerOrdersForLedger({ tenantId, orderId, connection }) {
  const [rows] = await connection.execute(`SELECT so.id, so.merchant_id, so.seller_order_number,
    so.grand_total, so.completed_at, co.store_id, m.display_name AS merchant_name,
    COALESCE(vp.default_commission_rate, 0) AS default_commission_rate,
    COALESCE(vp.settlement_cycle_days, 7) AS settlement_cycle_days,
    COALESCE((SELECT SUM(oi.taxable_amount) FROM order_items oi WHERE oi.seller_order_id = so.id), 0) AS taxable_value,
    COALESCE((SELECT SUM(oi.line_total) FROM order_items oi WHERE oi.seller_order_id = so.id), 0) AS item_total
    FROM seller_orders so JOIN customer_orders co ON co.id = so.customer_order_id
    JOIN merchants m ON m.id = so.merchant_id AND m.merchant_type = 'VENDOR'
    LEFT JOIN vendor_profiles vp ON vp.merchant_id = so.merchant_id
    WHERE so.tenant_id = ? AND so.customer_order_id = ? AND so.status = 'COMPLETED'
    FOR UPDATE`, [uuidToBuffer(tenantId), uuidToBuffer(orderId)]);
  return rows.map((row) => ({ id: bufferToUuid(row.id), merchantId: bufferToUuid(row.merchant_id),
    merchantName: row.merchant_name, sellerOrderNumber: row.seller_order_number,
    storeId: bufferToUuid(row.store_id), grandTotal: number(row.grand_total) || 0,
    taxableValue: number(row.taxable_value) || 0, itemTotal: number(row.item_total) || 0,
    completedAt: iso(row.completed_at), defaultCommissionRate: number(row.default_commission_rate) || 0,
    settlementCycleDays: Number(row.settlement_cycle_days || 7) }));
}

export async function sellerOrderLedgerExists({ tenantId, sellerOrderId, connection }) {
  const [rows] = await connection.execute(`SELECT id FROM merchant_ledger_entries
    WHERE tenant_id = ? AND reference_type = 'SELLER_ORDER' AND reference_id = ? LIMIT 1`,
  [uuidToBuffer(tenantId), uuidToBuffer(sellerOrderId)]);
  return Boolean(rows[0]);
}

export async function findEffectiveCommissionRule({ tenantId, sellerOrder, connection }) {
  const effectiveAt = sellerOrder.completedAt || new Date();
  const [rows] = await connection.execute(`SELECT cr.* FROM commission_rules cr
    WHERE cr.tenant_id = ? AND cr.status = 'ACTIVE' AND cr.effective_from <= ?
      AND (cr.effective_to IS NULL OR cr.effective_to > ?)
      AND ((cr.scope_type = 'MERCHANT' AND cr.merchant_id = ?)
        OR (cr.scope_type = 'STORE' AND cr.store_id = ?)
        OR cr.scope_type = 'GLOBAL')
    ORDER BY cr.priority DESC,
      CASE cr.scope_type WHEN 'MERCHANT' THEN 3 WHEN 'STORE' THEN 2 ELSE 1 END DESC,
      cr.effective_from DESC LIMIT 1`, [uuidToBuffer(tenantId), effectiveAt, effectiveAt,
    uuidToBuffer(sellerOrder.merchantId), uuidToBuffer(sellerOrder.storeId)]);
  if (!rows[0]) return null;
  return { id: bufferToUuid(rows[0].id), commissionType: rows[0].commission_type,
    commissionRate: number(rows[0].commission_rate), commissionAmount: number(rows[0].commission_amount),
    minimumCommission: number(rows[0].minimum_commission), maximumCommission: number(rows[0].maximum_commission),
    appliesOn: rows[0].applies_on };
}

export async function insertLedgerEntry({ entry, connection }) {
  await connection.execute(`INSERT INTO merchant_ledger_entries (id, tenant_id, merchant_id, seller_order_id,
    entry_type, direction, currency, amount, balance_effect, reference_type, reference_id, description,
    effective_at, available_at, settlement_status) VALUES (?, ?, ?, ?, ?, ?, 'INR', ?, ?, 'SELLER_ORDER', ?, ?, ?, ?, 'UNSETTLED')`,
  [uuidToBuffer(entry.id), uuidToBuffer(entry.tenantId), uuidToBuffer(entry.merchantId),
    uuidToBuffer(entry.sellerOrderId), entry.entryType, entry.direction, entry.amount, entry.balanceEffect,
    uuidToBuffer(entry.sellerOrderId), entry.description, entry.effectiveAt, entry.availableAt]);
}

export async function updateSellerOrderFinance({ sellerOrderId, commissionTotal, merchantPayableTotal, connection }) {
  await connection.execute(`UPDATE seller_orders SET commission_total = ?, merchant_payable_total = ?
    WHERE id = ?`, [commissionTotal, merchantPayableTotal, uuidToBuffer(sellerOrderId)]);
}

export async function listEligibleOrderIds({ tenantId, connection, limit = 100 }) {
  const [rows] = await connection.execute(`SELECT DISTINCT so.customer_order_id
    FROM seller_orders so JOIN merchants m ON m.id = so.merchant_id AND m.merchant_type = 'VENDOR'
    LEFT JOIN merchant_ledger_entries ml ON ml.tenant_id = so.tenant_id
      AND ml.reference_type = 'SELLER_ORDER' AND ml.reference_id = so.id
    WHERE so.tenant_id = ? AND so.status = 'COMPLETED' AND ml.id IS NULL
    ORDER BY so.completed_at, so.customer_order_id LIMIT ?`, [uuidToBuffer(tenantId), limit]);
  return rows.map((row) => bufferToUuid(row.customer_order_id));
}
