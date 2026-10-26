import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";

const number = (value) => value === null || value === undefined ? 0 : Number(value);
const iso = (value) => value ? new Date(value).toISOString() : null;
const dateOnly = (value) => value ? new Date(value).toISOString().slice(0, 10) : null;
function pageResult(rows, total, filters) { return { rows, total, page: filters.page, pageSize: filters.pageSize,
  totalPages: Math.max(1, Math.ceil(total / filters.pageSize)) }; }
function dateClause(column, filters, params) { params.push(filters.fromDate, filters.toDate);
  return `${column} >= ? AND ${column} < DATE_ADD(?, INTERVAL 1 DAY)`; }

export async function getOptions({ tenantId, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const [warehouseResult, merchantResult] = await Promise.all([
    connection.execute(`SELECT id, code, name FROM warehouses WHERE tenant_id = ?
      AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY name`, [tenant]),
    connection.execute(`SELECT id, merchant_code, display_name FROM merchants WHERE tenant_id = ?
      AND deleted_at IS NULL AND merchant_type = 'VENDOR' ORDER BY display_name`, [tenant])
  ]);
  return { warehouses: warehouseResult[0].map((row) => ({ id: bufferToUuid(row.id), code: row.code, name: row.name })),
    merchants: merchantResult[0].map((row) => ({ id: bufferToUuid(row.id), code: row.merchant_code, name: row.display_name })) };
}

async function getSalesReport({ tenantId, filters, connection }) {
  const tenant = uuidToBuffer(tenantId); const where = ["co.tenant_id = ?", "co.status NOT IN ('DRAFT','CANCELLED')"];
  const params = [tenant]; where.push(dateClause("co.created_at", filters, params));
  if (filters.merchantId) { where.push("EXISTS (SELECT 1 FROM seller_orders sx WHERE sx.customer_order_id = co.id AND sx.merchant_id = ?)");
    params.push(uuidToBuffer(filters.merchantId)); }
  const clause = where.join(" AND "); const offset = (filters.page - 1) * filters.pageSize;
  const [summaryResult, trendResult, rowsResult, countResult] = await Promise.all([
    connection.execute(`SELECT COUNT(*) AS order_count, COALESCE(SUM(co.grand_total), 0) AS gross_sales,
      COALESCE(SUM(co.refunded_total), 0) AS refunds, COALESCE(SUM(co.grand_total - co.refunded_total), 0) AS net_sales,
      COALESCE(AVG(co.grand_total), 0) AS average_order_value FROM customer_orders co WHERE ${clause}`, params),
    connection.execute(`SELECT DATE(co.created_at) AS period, COUNT(*) AS order_count,
      COALESCE(SUM(co.grand_total - co.refunded_total), 0) AS value FROM customer_orders co
      WHERE ${clause} GROUP BY DATE(co.created_at) ORDER BY period`, params),
    connection.execute(`SELECT co.id, co.order_number, co.created_at, co.status, co.payment_status,
      co.fulfillment_status, co.subtotal, co.discount_total, co.tax_total, co.grand_total, co.refunded_total,
      s.name AS store_name, (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.customer_order_id = co.id) AS units
      FROM customer_orders co JOIN stores s ON s.id = co.store_id WHERE ${clause}
      ORDER BY co.created_at DESC LIMIT ? OFFSET ?`, [...params, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total FROM customer_orders co WHERE ${clause}`, params)
  ]);
  const summary = summaryResult[0][0]; const total = Number(countResult[0][0].total || 0);
  return { summary: { orderCount: number(summary.order_count), grossSales: number(summary.gross_sales),
    refunds: number(summary.refunds), netSales: number(summary.net_sales), averageOrderValue: number(summary.average_order_value) },
  trend: trendResult[0].map((row) => ({ period: dateOnly(row.period), value: number(row.value), secondaryValue: number(row.order_count) })),
  ...pageResult(rowsResult[0].map((row) => ({ id: bufferToUuid(row.id), orderNumber: row.order_number,
    orderDate: iso(row.created_at), storeName: row.store_name, status: row.status, paymentStatus: row.payment_status,
    fulfillmentStatus: row.fulfillment_status, units: number(row.units), subtotal: number(row.subtotal),
    discountTotal: number(row.discount_total), taxTotal: number(row.tax_total), grandTotal: number(row.grand_total),
    refundedTotal: number(row.refunded_total) })), total, filters) };
}

async function getInventoryReport({ tenantId, filters, connection }) {
  const tenant = uuidToBuffer(tenantId); const where = ["ib.tenant_id = ?", "so.deleted_at IS NULL"]; const params = [tenant];
  if (filters.warehouseId) { where.push("ib.warehouse_id = ?"); params.push(uuidToBuffer(filters.warehouseId)); }
  if (filters.merchantId) { where.push("so.merchant_id = ?"); params.push(uuidToBuffer(filters.merchantId)); }
  const clause = where.join(" AND "); const offset = (filters.page - 1) * filters.pageSize;
  const joins = `FROM inventory_balances ib JOIN warehouses w ON w.id = ib.warehouse_id
    JOIN seller_offers so ON so.id = ib.offer_id JOIN merchants m ON m.id = so.merchant_id
    JOIN product_variants pv ON pv.id = so.variant_id JOIN products p ON p.id = pv.product_id`;
  const [summaryResult, trendResult, rowsResult, countResult] = await Promise.all([
    connection.execute(`SELECT COUNT(DISTINCT ib.offer_id) AS sku_count, COALESCE(SUM(ib.on_hand_quantity), 0) AS on_hand,
      COALESCE(SUM(GREATEST(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity, 0)), 0) AS available,
      COALESCE(SUM(ib.reserved_quantity), 0) AS reserved, COALESCE(SUM(ib.quarantine_quantity), 0) AS quarantine,
      SUM(CASE WHEN ib.reorder_point_quantity IS NOT NULL AND
        (ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity) <= ib.reorder_point_quantity THEN 1 ELSE 0 END) AS low_stock
      ${joins} WHERE ${clause}`, params),
    connection.execute(`SELECT w.name AS period,
      COALESCE(SUM(GREATEST(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity, 0)), 0) AS value,
      COUNT(DISTINCT ib.offer_id) AS secondary_value ${joins} WHERE ${clause}
      GROUP BY w.id, w.name ORDER BY value DESC LIMIT 12`, params),
    connection.execute(`SELECT ib.id, p.name AS product_name, pv.name AS variant_name, pv.sku, so.seller_sku,
      w.name AS warehouse_name, m.display_name AS merchant_name, ib.on_hand_quantity, ib.reserved_quantity,
      ib.quarantine_quantity, ib.reorder_point_quantity, ib.last_movement_at,
      GREATEST(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity, 0) AS available_quantity
      ${joins} WHERE ${clause} ORDER BY available_quantity, p.name LIMIT ? OFFSET ?`, [...params, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total ${joins} WHERE ${clause}`, params)
  ]);
  const summary = summaryResult[0][0]; const total = Number(countResult[0][0].total || 0);
  return { summary: { skuCount: number(summary.sku_count), onHand: number(summary.on_hand), available: number(summary.available),
    reserved: number(summary.reserved), quarantine: number(summary.quarantine), lowStock: number(summary.low_stock) },
  trend: trendResult[0].map((row) => ({ period: row.period, value: number(row.value), secondaryValue: number(row.secondary_value) })),
  ...pageResult(rowsResult[0].map((row) => { const available = number(row.available_quantity);
    const reorder = row.reorder_point_quantity === null ? null : number(row.reorder_point_quantity);
    return { id: bufferToUuid(row.id), productName: row.product_name, variantName: row.variant_name, sku: row.sku,
      sellerSku: row.seller_sku, warehouseName: row.warehouse_name, merchantName: row.merchant_name,
      onHand: number(row.on_hand_quantity), available, reserved: number(row.reserved_quantity), quarantine: number(row.quarantine_quantity),
      reorderPoint: reorder, health: available <= 0 ? "OUT" : reorder !== null && available <= reorder ? "LOW" : "HEALTHY",
      lastMovementAt: iso(row.last_movement_at) }; }), total, filters) };
}

async function getExpiryReport({ tenantId, filters, connection }) {
  const tenant = uuidToBuffer(tenantId); const where = ["il.tenant_id = ?", "il.expires_at IS NOT NULL", "il.status = 'ACTIVE'"];
  const params = [tenant]; where.push(dateClause("il.expires_at", filters, params));
  if (filters.warehouseId) { where.push("ib.warehouse_id = ?"); params.push(uuidToBuffer(filters.warehouseId)); }
  if (filters.merchantId) { where.push("so.merchant_id = ?"); params.push(uuidToBuffer(filters.merchantId)); }
  const clause = where.join(" AND "); const offset = (filters.page - 1) * filters.pageSize;
  const joins = `FROM inventory_lots il JOIN inventory_balances ib ON ib.id = il.inventory_balance_id
    JOIN warehouses w ON w.id = ib.warehouse_id JOIN seller_offers so ON so.id = ib.offer_id
    JOIN product_variants pv ON pv.id = so.variant_id JOIN products p ON p.id = pv.product_id`;
  const [summaryResult, trendResult, rowsResult, countResult] = await Promise.all([
    connection.execute(`SELECT COUNT(*) AS lot_count, COALESCE(SUM(il.on_hand_quantity), 0) AS affected_units,
      SUM(il.expires_at < UTC_DATE()) AS expired_lots,
      SUM(il.expires_at >= UTC_DATE() AND il.expires_at <= DATE_ADD(UTC_DATE(), INTERVAL 30 DAY)) AS expiring_lots
      ${joins} WHERE ${clause}`, params),
    connection.execute(`SELECT il.expires_at AS period, COALESCE(SUM(il.on_hand_quantity), 0) AS value,
      COUNT(*) AS secondary_value ${joins} WHERE ${clause} GROUP BY il.expires_at ORDER BY period`, params),
    connection.execute(`SELECT il.id, il.lot_number, il.supplier_lot_number, il.manufactured_at, il.expires_at,
      il.on_hand_quantity, il.reserved_quantity, il.quarantine_quantity, il.unit_cost, p.name AS product_name,
      pv.name AS variant_name, pv.sku, w.name AS warehouse_name ${joins} WHERE ${clause}
      ORDER BY il.expires_at, p.name LIMIT ? OFFSET ?`, [...params, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total ${joins} WHERE ${clause}`, params)
  ]);
  const summary = summaryResult[0][0]; const total = Number(countResult[0][0].total || 0);
  return { summary: { lotCount: number(summary.lot_count), affectedUnits: number(summary.affected_units),
    expiredLots: number(summary.expired_lots), expiringLots: number(summary.expiring_lots) },
  trend: trendResult[0].map((row) => ({ period: dateOnly(row.period), value: number(row.value), secondaryValue: number(row.secondary_value) })),
  ...pageResult(rowsResult[0].map((row) => { const expiryDate = dateOnly(row.expires_at);
    const daysRemaining = Math.ceil((new Date(`${expiryDate}T00:00:00Z`) - new Date(`${filters.today}T00:00:00Z`)) / 86400000);
    return { id: bufferToUuid(row.id), productName: row.product_name, variantName: row.variant_name, sku: row.sku,
      lotNumber: row.lot_number, supplierLotNumber: row.supplier_lot_number, warehouseName: row.warehouse_name,
      manufacturedAt: dateOnly(row.manufactured_at), expiresAt: expiryDate, daysRemaining,
      onHand: number(row.on_hand_quantity), reserved: number(row.reserved_quantity), quarantine: number(row.quarantine_quantity),
      unitCost: number(row.unit_cost), health: daysRemaining < 0 ? "EXPIRED" : daysRemaining <= 30 ? "EXPIRING" : "HEALTHY" }; }), total, filters) };
}

async function getVendorReport({ tenantId, filters, connection }) {
  const tenant = uuidToBuffer(tenantId); const where = ["so.tenant_id = ?", "m.merchant_type = 'VENDOR'", "so.status <> 'CANCELLED'"];
  const params = [tenant]; where.push(dateClause("so.created_at", filters, params));
  if (filters.merchantId) { where.push("so.merchant_id = ?"); params.push(uuidToBuffer(filters.merchantId)); }
  const clause = where.join(" AND "); const offset = (filters.page - 1) * filters.pageSize;
  const group = "GROUP BY m.id, m.merchant_code, m.display_name, m.status";
  const [summaryResult, trendResult, rowsResult, countResult] = await Promise.all([
    connection.execute(`SELECT COUNT(DISTINCT so.merchant_id) AS vendor_count, COUNT(*) AS order_count,
      COALESCE(SUM(so.grand_total), 0) AS gross_sales, COALESCE(SUM(so.commission_total), 0) AS commission,
      COALESCE(SUM(so.merchant_payable_total), 0) AS payable FROM seller_orders so JOIN merchants m ON m.id = so.merchant_id
      WHERE ${clause}`, params),
    connection.execute(`SELECT m.display_name AS period, COALESCE(SUM(so.grand_total), 0) AS value,
      COUNT(*) AS secondary_value FROM seller_orders so JOIN merchants m ON m.id = so.merchant_id WHERE ${clause}
      ${group} ORDER BY value DESC LIMIT 12`, params),
    connection.execute(`SELECT m.id, m.merchant_code, m.display_name, m.status, COUNT(*) AS order_count,
      SUM(so.status = 'COMPLETED') AS completed_orders, COALESCE(SUM(so.grand_total), 0) AS gross_sales,
      COALESCE(SUM(so.commission_total), 0) AS commission, COALESCE(SUM(so.tcs_total), 0) AS tcs,
      COALESCE(SUM(so.tds_total), 0) AS tds, COALESCE(SUM(so.merchant_payable_total), 0) AS payable,
      MAX(so.created_at) AS last_order_at FROM seller_orders so JOIN merchants m ON m.id = so.merchant_id
      WHERE ${clause} ${group} ORDER BY gross_sales DESC, m.display_name LIMIT ? OFFSET ?`, [...params, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(DISTINCT so.merchant_id) AS total FROM seller_orders so JOIN merchants m ON m.id = so.merchant_id WHERE ${clause}`, params)
  ]);
  const summary = summaryResult[0][0]; const total = Number(countResult[0][0].total || 0);
  return { summary: { vendorCount: number(summary.vendor_count), orderCount: number(summary.order_count),
    grossSales: number(summary.gross_sales), commission: number(summary.commission), payable: number(summary.payable) },
  trend: trendResult[0].map((row) => ({ period: row.period, value: number(row.value), secondaryValue: number(row.secondary_value) })),
  ...pageResult(rowsResult[0].map((row) => ({ id: bufferToUuid(row.id), merchantCode: row.merchant_code,
    merchantName: row.display_name, status: row.status, orderCount: number(row.order_count),
    completedOrders: number(row.completed_orders), grossSales: number(row.gross_sales), commission: number(row.commission),
    tcs: number(row.tcs), tds: number(row.tds), payable: number(row.payable), lastOrderAt: iso(row.last_order_at) })), total, filters) };
}

async function getWithholdingReport({ tenantId, filters, connection, type }) {
  const tenant = uuidToBuffer(tenantId); const where = ["mtw.tenant_id = ?", "mtw.withholding_type = ?"];
  const params = [tenant, type]; where.push(dateClause("mtw.created_at", filters, params));
  if (filters.merchantId) { where.push("mtw.merchant_id = ?"); params.push(uuidToBuffer(filters.merchantId)); }
  const clause = where.join(" AND "); const offset = (filters.page - 1) * filters.pageSize;
  const joins = `FROM merchant_tax_withholdings mtw JOIN merchants m ON m.id = mtw.merchant_id
    LEFT JOIN seller_orders so ON so.id = mtw.seller_order_id`;
  const [summaryResult, trendResult, rowsResult, countResult] = await Promise.all([
    connection.execute(`SELECT COUNT(*) AS record_count, COALESCE(SUM(mtw.taxable_base), 0) AS taxable_base,
      COALESCE(SUM(mtw.amount), 0) AS amount, SUM(mtw.status = 'DEPOSITED') AS deposited_count,
      COALESCE(SUM(CASE WHEN mtw.status = 'DEPOSITED' THEN mtw.amount ELSE 0 END), 0) AS deposited_amount
      ${joins} WHERE ${clause}`, params),
    connection.execute(`SELECT CONCAT(mtw.financial_year, ' / ', LPAD(mtw.period_month, 2, '0')) AS period,
      COALESCE(SUM(mtw.amount), 0) AS value, COUNT(*) AS secondary_value ${joins} WHERE ${clause}
      GROUP BY mtw.financial_year, mtw.period_month ORDER BY mtw.financial_year, mtw.period_month`, params),
    connection.execute(`SELECT mtw.id, mtw.withholding_type, mtw.tax_section, mtw.taxable_base, mtw.rate,
      mtw.amount, mtw.financial_year, mtw.period_month, mtw.status, mtw.government_reference,
      mtw.deposited_at, mtw.created_at, m.merchant_code, m.display_name, so.seller_order_number
      ${joins} WHERE ${clause} ORDER BY mtw.created_at DESC LIMIT ? OFFSET ?`, [...params, filters.pageSize, offset]),
    connection.execute(`SELECT COUNT(*) AS total ${joins} WHERE ${clause}`, params)
  ]);
  const summary = summaryResult[0][0]; const total = Number(countResult[0][0].total || 0);
  return { summary: { recordCount: number(summary.record_count), taxableBase: number(summary.taxable_base),
    amount: number(summary.amount), depositedCount: number(summary.deposited_count), depositedAmount: number(summary.deposited_amount),
    pendingAmount: number(summary.amount) - number(summary.deposited_amount) },
  trend: trendResult[0].map((row) => ({ period: row.period, value: number(row.value), secondaryValue: number(row.secondary_value) })),
  ...pageResult(rowsResult[0].map((row) => ({ id: bufferToUuid(row.id), type: row.withholding_type,
    taxSection: row.tax_section, taxableBase: number(row.taxable_base), rate: number(row.rate) * 100,
    amount: number(row.amount), financialYear: row.financial_year, periodMonth: Number(row.period_month), status: row.status,
    governmentReference: row.government_reference, depositedAt: iso(row.deposited_at), createdAt: iso(row.created_at),
    merchantCode: row.merchant_code, merchantName: row.display_name, sellerOrderNumber: row.seller_order_number })), total, filters) };
}

export async function getReport({ tenantId, filters, connection = getPrimaryPool() }) {
  const args = { tenantId, filters, connection };
  if (filters.reportType === "INVENTORY") return getInventoryReport(args);
  if (filters.reportType === "EXPIRY") return getExpiryReport(args);
  if (filters.reportType === "VENDOR") return getVendorReport(args);
  if (filters.reportType === "GST_TCS") return getWithholdingReport({ ...args, type: "GST_TCS" });
  if (filters.reportType === "GST_TDS") return getWithholdingReport({ ...args, type: "INCOME_TAX_TDS" });
  return getSalesReport(args);
}
