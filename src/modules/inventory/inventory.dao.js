import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";

const number = (value) => value === null || value === undefined ? null : Number(value);
const iso = (value) => value ? new Date(value).toISOString() : null;
const escapeLike = (value) => value.replace(/[\\%_]/g, "\\$&");

export async function listOptions({ tenantId, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const [warehouseRows] = await connection.execute(
    `SELECT w.id, w.code, w.name, w.warehouse_type, w.status, w.merchant_id,
            m.display_name AS merchant_name, a.city, a.state_name, a.postal_code,
            (SELECT COUNT(*) FROM inventory_balances ib WHERE ib.warehouse_id = w.id) AS stock_item_count
       FROM warehouses w JOIN merchants m ON m.id = w.merchant_id
       JOIN addresses a ON a.id = w.address_id
      WHERE w.tenant_id = ? AND w.status = 'ACTIVE' AND w.deleted_at IS NULL
      ORDER BY w.priority DESC, w.name`, [tenant]
  );
  const [offerRows] = await connection.execute(
    `SELECT so.id, so.merchant_id, p.name AS product_name, pv.name AS variant_name, pv.sku,
            pv.sold_by_weight, u.code AS uom_code, pt.vertical,
            pt.lot_tracking_enabled, pt.serial_tracking_enabled, pt.expiry_tracking_enabled
       FROM seller_offers so
       JOIN product_variants pv ON pv.id = so.variant_id AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL
       JOIN products p ON p.id = pv.product_id AND p.deleted_at IS NULL
       JOIN product_types pt ON pt.id = p.product_type_id AND pt.deleted_at IS NULL
       JOIN units_of_measure u ON u.id = pv.selling_uom_id
      WHERE so.tenant_id = ? AND so.deleted_at IS NULL
      ORDER BY p.name, pv.sku`, [tenant]
  );
  return {
    warehouses: warehouseRows.map((row) => ({ id: bufferToUuid(row.id), code: row.code, name: row.name,
      type: row.warehouse_type, status: row.status, merchantId: bufferToUuid(row.merchant_id),
      merchantName: row.merchant_name, city: row.city, stateName: row.state_name,
      postalCode: row.postal_code, stockItemCount: Number(row.stock_item_count) })),
    offers: offerRows.map((row) => ({ id: bufferToUuid(row.id), merchantId: bufferToUuid(row.merchant_id),
      productName: row.product_name, variantName: row.variant_name, sku: row.sku,
      soldByWeight: Boolean(row.sold_by_weight), uomCode: row.uom_code, vertical: row.vertical,
      lotTrackingEnabled: Boolean(row.lot_tracking_enabled),
      serialTrackingEnabled: Boolean(row.serial_tracking_enabled),
      expiryTrackingEnabled: Boolean(row.expiry_tracking_enabled) }))
  };
}

export async function findDefaultScope({ tenantId, connection }) {
  const [rows] = await connection.execute(
    `SELECT s.id AS store_id, s.business_address_id, m.id AS merchant_id
       FROM stores s JOIN store_merchants sm ON sm.store_id = s.id AND sm.status = 'ACTIVE'
       JOIN merchants m ON m.id = sm.merchant_id AND m.status = 'ACTIVE' AND m.merchant_type = 'FIRST_PARTY'
      WHERE s.tenant_id = ? AND s.status = 'ACTIVE' AND s.deleted_at IS NULL AND m.deleted_at IS NULL
      ORDER BY s.created_at, m.created_at LIMIT 1`, [uuidToBuffer(tenantId)]
  );
  return rows[0] ? { storeId: bufferToUuid(rows[0].store_id), merchantId: bufferToUuid(rows[0].merchant_id) } : null;
}

export async function insertAddress({ address, connection }) {
  await connection.execute(
    `INSERT INTO addresses (id, tenant_id, company_name, line1, line2, city, state_code, state_name, postal_code, country_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN')`,
    [uuidToBuffer(address.id), uuidToBuffer(address.tenantId), address.companyName, address.line1,
      address.line2 || null, address.city, address.stateCode, address.stateName, address.postalCode]
  );
}

export async function insertWarehouse({ warehouse, connection }) {
  await connection.execute(
    `INSERT INTO warehouses (id, tenant_id, store_id, merchant_id, code, name, warehouse_type, status, address_id)
     VALUES (?, ?, ?, ?, ?, ?, 'STANDARD', 'ACTIVE', ?)`,
    [uuidToBuffer(warehouse.id), uuidToBuffer(warehouse.tenantId), uuidToBuffer(warehouse.storeId),
      uuidToBuffer(warehouse.merchantId), warehouse.code, warehouse.name, uuidToBuffer(warehouse.addressId)]
  );
}

export async function findWarehouse({ tenantId, warehouseId, connection }) {
  const [rows] = await connection.execute(
    `SELECT id, merchant_id, name FROM warehouses
      WHERE tenant_id = ? AND id = ? AND status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(warehouseId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), merchantId: bufferToUuid(rows[0].merchant_id), name: rows[0].name } : null;
}

export async function findOfferContext({ tenantId, offerId, connection }) {
  const [rows] = await connection.execute(
    `SELECT so.id, so.merchant_id, p.name AS product_name, pv.sku, pv.sold_by_weight,
            pt.lot_tracking_enabled, pt.serial_tracking_enabled, pt.expiry_tracking_enabled
       FROM seller_offers so JOIN product_variants pv ON pv.id = so.variant_id
       JOIN products p ON p.id = pv.product_id JOIN product_types pt ON pt.id = p.product_type_id
      WHERE so.tenant_id = ? AND so.id = ? AND so.deleted_at IS NULL
        AND pv.deleted_at IS NULL AND p.deleted_at IS NULL LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(offerId)]
  );
  if (!rows[0]) return null;
  return { id: bufferToUuid(rows[0].id), merchantId: bufferToUuid(rows[0].merchant_id),
    productName: rows[0].product_name, sku: rows[0].sku, soldByWeight: Boolean(rows[0].sold_by_weight),
    lotTrackingEnabled: Boolean(rows[0].lot_tracking_enabled),
    serialTrackingEnabled: Boolean(rows[0].serial_tracking_enabled),
    expiryTrackingEnabled: Boolean(rows[0].expiry_tracking_enabled) };
}

export async function findBalance({ tenantId, warehouseId, offerId, connection, forUpdate = false }) {
  const [rows] = await connection.execute(
    `SELECT id, on_hand_quantity, reserved_quantity, quarantine_quantity FROM inventory_balances
      WHERE tenant_id = ? AND warehouse_id = ? AND offer_id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(warehouseId), uuidToBuffer(offerId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), onHandQuantity: number(rows[0].on_hand_quantity),
    reservedQuantity: number(rows[0].reserved_quantity), quarantineQuantity: number(rows[0].quarantine_quantity) } : null;
}

export async function insertBalance({ balance, connection }) {
  await connection.execute(
    `INSERT INTO inventory_balances (id, tenant_id, warehouse_id, offer_id, on_hand_quantity, last_movement_at)
     VALUES (?, ?, ?, ?, 0, UTC_TIMESTAMP(6))`,
    [uuidToBuffer(balance.id), uuidToBuffer(balance.tenantId), uuidToBuffer(balance.warehouseId), uuidToBuffer(balance.offerId)]
  );
}

export async function updateBalanceQuantity({ balanceId, delta, connection }) {
  await connection.execute(
    `UPDATE inventory_balances SET on_hand_quantity = on_hand_quantity + ?, version = version + 1,
            last_movement_at = UTC_TIMESTAMP(6) WHERE id = ?`, [delta, uuidToBuffer(balanceId)]
  );
}

export async function findLot({ tenantId, balanceId, lotId = null, lotNumber = null, connection, forUpdate = false }) {
  const by = lotId ? "il.id = ?" : "il.lot_number = ?";
  const value = lotId ? uuidToBuffer(lotId) : lotNumber;
  const [rows] = await connection.execute(
    `SELECT il.id, il.lot_number, il.manufactured_at, il.expires_at, il.unit_cost,
            il.on_hand_quantity, il.reserved_quantity, il.quarantine_quantity
       FROM inventory_lots il WHERE il.tenant_id = ? AND il.inventory_balance_id = ? AND ${by}
       LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(balanceId), value]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), lotNumber: rows[0].lot_number,
    manufacturedAt: rows[0].manufactured_at || null, expiresAt: rows[0].expires_at || null,
    unitCost: number(rows[0].unit_cost), onHandQuantity: number(rows[0].on_hand_quantity),
    reservedQuantity: number(rows[0].reserved_quantity), quarantineQuantity: number(rows[0].quarantine_quantity) } : null;
}

export async function insertLot({ lot, connection }) {
  await connection.execute(
    `INSERT INTO inventory_lots (id, tenant_id, inventory_balance_id, lot_number, manufactured_at,
       expires_at, received_at, on_hand_quantity, unit_cost, status)
     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), ?, ?, 'ACTIVE')`,
    [uuidToBuffer(lot.id), uuidToBuffer(lot.tenantId), uuidToBuffer(lot.balanceId), lot.lotNumber,
      lot.manufacturedAt || null, lot.expiresAt || null, lot.quantity, lot.unitCost]
  );
}

export async function updateLotQuantity({ lotId, delta, unitCost, connection }) {
  await connection.execute(
    `UPDATE inventory_lots SET on_hand_quantity = on_hand_quantity + ?,
       unit_cost = COALESCE(?, unit_cost), version = version + 1 WHERE id = ?`,
    [delta, unitCost, uuidToBuffer(lotId)]
  );
}

export async function insertReceipt({ receipt, connection }) {
  await connection.execute(
    `INSERT INTO goods_receipts (id, tenant_id, receipt_number, purchase_order_id, warehouse_id, supplier_document_number,
       status, received_at, received_by, notes) VALUES (?, ?, ?, ?, ?, ?, 'POSTED', UTC_TIMESTAMP(6), ?, ?)`,
    [uuidToBuffer(receipt.id), uuidToBuffer(receipt.tenantId), receipt.number,
      receipt.purchaseOrderId ? uuidToBuffer(receipt.purchaseOrderId) : null, uuidToBuffer(receipt.warehouseId),
      receipt.supplierDocumentNumber || null, uuidToBuffer(receipt.userId), receipt.notes || null]
  );
}

export async function insertReceiptItem({ item, connection }) {
  await connection.execute(
    `INSERT INTO goods_receipt_items (id, goods_receipt_id, purchase_order_item_id, offer_id, received_quantity,
       accepted_quantity, rejected_quantity, lot_number, manufactured_at, expires_at, unit_cost, serials_json)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(item.id), uuidToBuffer(item.receiptId),
      item.purchaseOrderItemId ? uuidToBuffer(item.purchaseOrderItemId) : null,
      uuidToBuffer(item.offerId), item.quantity,
      item.quantity, item.lotNumber || null, item.manufacturedAt || null, item.expiresAt || null,
      item.unitCost, item.serialNumbers.length ? JSON.stringify(item.serialNumbers) : null]
  );
}

export async function findPurchaseOrderItemForReceipt({ tenantId, purchaseOrderId,
  purchaseOrderItemId, connection }) {
  const [rows] = await connection.execute(`SELECT po.id AS purchase_order_id, po.purchase_order_number,
    po.warehouse_id, po.status, poi.id AS item_id, poi.offer_id, poi.ordered_quantity,
    poi.received_quantity, poi.unit_cost FROM purchase_orders po
    JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
    WHERE po.tenant_id = ? AND po.id = ? AND poi.id = ? LIMIT 1 FOR UPDATE`,
  [uuidToBuffer(tenantId), uuidToBuffer(purchaseOrderId), uuidToBuffer(purchaseOrderItemId)]);
  if (!rows[0]) return null; const row = rows[0];
  return { purchaseOrderId: bufferToUuid(row.purchase_order_id), purchaseOrderNumber: row.purchase_order_number,
    purchaseOrderItemId: bufferToUuid(row.item_id), warehouseId: bufferToUuid(row.warehouse_id),
    offerId: bufferToUuid(row.offer_id), status: row.status, orderedQuantity: number(row.ordered_quantity),
    receivedQuantity: number(row.received_quantity), unitCost: number(row.unit_cost) };
}

export async function updatePurchaseOrderReceipt({ purchaseOrderId, purchaseOrderItemId, quantity, connection }) {
  const [result] = await connection.execute(`UPDATE purchase_order_items
    SET received_quantity = received_quantity + ? WHERE id = ?
    AND received_quantity + ? <= ordered_quantity`, [quantity, uuidToBuffer(purchaseOrderItemId), quantity]);
  if (result.affectedRows !== 1) return null;
  await connection.execute(`UPDATE purchase_orders po SET status = CASE
    WHEN NOT EXISTS (SELECT 1 FROM purchase_order_items poi WHERE poi.purchase_order_id = po.id
      AND poi.received_quantity < poi.ordered_quantity) THEN 'RECEIVED'
    ELSE 'PARTIALLY_RECEIVED' END WHERE po.id = ?`, [uuidToBuffer(purchaseOrderId)]);
  const [rows] = await connection.execute("SELECT status FROM purchase_orders WHERE id = ?", [uuidToBuffer(purchaseOrderId)]);
  return rows[0]?.status || null;
}

export async function insertSerial({ serial, connection }) {
  await connection.execute(
    `INSERT INTO serial_numbers (id, tenant_id, inventory_balance_id, inventory_lot_id,
       serial_number, status, received_at) VALUES (?, ?, ?, ?, ?, 'AVAILABLE', UTC_TIMESTAMP(6))`,
    [uuidToBuffer(serial.id), uuidToBuffer(serial.tenantId), uuidToBuffer(serial.balanceId),
      serial.lotId ? uuidToBuffer(serial.lotId) : null, serial.number]
  );
}

function lotHealthSql(alias = "il") {
  return `CASE
    WHEN ${alias}.on_hand_quantity <= 0 THEN 'DEPLETED'
    WHEN ${alias}.quarantine_quantity >= ${alias}.on_hand_quantity THEN 'QUARANTINED'
    WHEN ${alias}.expires_at < UTC_DATE() THEN 'EXPIRED'
    WHEN ${alias}.expires_at <= DATE_ADD(UTC_DATE(), INTERVAL 30 DAY) THEN 'EXPIRING'
    ELSE 'HEALTHY' END`;
}

export async function listTraceabilityLots({
  tenantId, search, health, warehouseId, page, pageSize, connection = getPrimaryPool()
}) {
  const where = ["il.tenant_id = ?", "il.status = 'ACTIVE'"];
  const parameters = [uuidToBuffer(tenantId)];
  if (search) {
    const term = `%${escapeLike(search)}%`;
    where.push("(il.lot_number LIKE ? ESCAPE '\\\\' OR p.name LIKE ? ESCAPE '\\\\' OR pv.sku LIKE ? ESCAPE '\\\\' OR w.name LIKE ? ESCAPE '\\\\')");
    parameters.push(term, term, term, term);
  }
  if (warehouseId) {
    where.push("ib.warehouse_id = ?");
    parameters.push(uuidToBuffer(warehouseId));
  }
  if (health !== "ALL") {
    where.push(`${lotHealthSql()} = ?`);
    parameters.push(health);
  }
  const clause = where.join(" AND ");
  const joins = `FROM inventory_lots il
    JOIN inventory_balances ib ON ib.id = il.inventory_balance_id
    JOIN seller_offers so ON so.id = ib.offer_id
    JOIN product_variants pv ON pv.id = so.variant_id
    JOIN products p ON p.id = pv.product_id
    JOIN warehouses w ON w.id = ib.warehouse_id
    JOIN merchants m ON m.id = w.merchant_id`;
  const [countRows] = await connection.execute(
    `SELECT COUNT(*) AS total ${joins} WHERE ${clause}`, parameters
  );
  const [rows] = await connection.execute(
    `SELECT il.id, il.inventory_balance_id, il.lot_number, il.manufactured_at,
            il.expires_at, il.received_at, il.on_hand_quantity, il.reserved_quantity,
            il.quarantine_quantity, il.unit_cost, ${lotHealthSql()} AS health,
            p.name AS product_name, pv.name AS variant_name, pv.sku,
            w.id AS warehouse_id, w.name AS warehouse_name, m.display_name AS merchant_name
       ${joins}
      WHERE ${clause}
      ORDER BY FIELD(health, 'EXPIRED', 'EXPIRING', 'QUARANTINED', 'HEALTHY', 'DEPLETED'),
               il.expires_at IS NULL, il.expires_at, p.name
      LIMIT ? OFFSET ?`, [...parameters, pageSize, (page - 1) * pageSize]
  );
  return {
    items: rows.map((row) => ({
      id: bufferToUuid(row.id), balanceId: bufferToUuid(row.inventory_balance_id),
      lotNumber: row.lot_number, productName: row.product_name, variantName: row.variant_name,
      sku: row.sku, warehouseId: bufferToUuid(row.warehouse_id), warehouseName: row.warehouse_name,
      merchantName: row.merchant_name,
      manufacturedAt: row.manufactured_at ? iso(row.manufactured_at).slice(0, 10) : null,
      expiresAt: row.expires_at ? iso(row.expires_at).slice(0, 10) : null,
      receivedAt: iso(row.received_at), onHandQuantity: number(row.on_hand_quantity),
      reservedQuantity: number(row.reserved_quantity), quarantineQuantity: number(row.quarantine_quantity),
      availableQuantity: number(row.on_hand_quantity) - number(row.reserved_quantity) - number(row.quarantine_quantity),
      unitCost: number(row.unit_cost), health: row.health
    })),
    total: Number(countRows[0].total)
  };
}

export async function summarizeTraceabilityLots({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS total,
            SUM(${lotHealthSql()} = 'EXPIRING') AS expiring,
            SUM(${lotHealthSql()} = 'EXPIRED') AS expired,
            SUM(${lotHealthSql()} = 'QUARANTINED') AS quarantined
       FROM inventory_lots il WHERE il.tenant_id = ? AND il.status = 'ACTIVE'`,
    [uuidToBuffer(tenantId)]
  );
  const row = rows[0];
  return { total: number(row.total) || 0, expiring: number(row.expiring) || 0,
    expired: number(row.expired) || 0, quarantined: number(row.quarantined) || 0 };
}

export async function listTraceabilitySerials({
  tenantId, search, status, warehouseId, page, pageSize, connection = getPrimaryPool()
}) {
  const where = ["sn.tenant_id = ?"];
  const parameters = [uuidToBuffer(tenantId)];
  if (search) {
    const term = `%${escapeLike(search)}%`;
    where.push("(sn.serial_number LIKE ? ESCAPE '\\\\' OR sn.secondary_identifier LIKE ? ESCAPE '\\\\' OR p.name LIKE ? ESCAPE '\\\\' OR pv.sku LIKE ? ESCAPE '\\\\' OR w.name LIKE ? ESCAPE '\\\\')");
    parameters.push(term, term, term, term, term);
  }
  if (warehouseId) {
    where.push("ib.warehouse_id = ?");
    parameters.push(uuidToBuffer(warehouseId));
  }
  if (status !== "ALL") {
    where.push("sn.status = ?");
    parameters.push(status);
  }
  const clause = where.join(" AND ");
  const joins = `FROM serial_numbers sn
    JOIN inventory_balances ib ON ib.id = sn.inventory_balance_id
    JOIN seller_offers so ON so.id = ib.offer_id
    JOIN product_variants pv ON pv.id = so.variant_id
    JOIN products p ON p.id = pv.product_id
    JOIN warehouses w ON w.id = ib.warehouse_id
    JOIN merchants m ON m.id = w.merchant_id
    LEFT JOIN inventory_lots il ON il.id = sn.inventory_lot_id`;
  const [countRows] = await connection.execute(
    `SELECT COUNT(*) AS total ${joins} WHERE ${clause}`, parameters
  );
  const [rows] = await connection.execute(
    `SELECT sn.id, sn.inventory_balance_id, sn.serial_number, sn.secondary_identifier,
            sn.status, sn.received_at, sn.sold_at, sn.warranty_starts_at, sn.warranty_ends_at,
            p.name AS product_name, pv.name AS variant_name, pv.sku,
            w.id AS warehouse_id, w.name AS warehouse_name, m.display_name AS merchant_name,
            il.id AS lot_id, il.lot_number
       ${joins}
      WHERE ${clause}
      ORDER BY FIELD(sn.status, 'QUARANTINED', 'RESERVED', 'AVAILABLE', 'SOLD', 'SCRAPPED'),
               sn.updated_at DESC, p.name
      LIMIT ? OFFSET ?`, [...parameters, pageSize, (page - 1) * pageSize]
  );
  return {
    items: rows.map((row) => ({
      id: bufferToUuid(row.id), balanceId: bufferToUuid(row.inventory_balance_id),
      serialNumber: row.serial_number, secondaryIdentifier: row.secondary_identifier,
      status: row.status, productName: row.product_name, variantName: row.variant_name,
      sku: row.sku, warehouseId: bufferToUuid(row.warehouse_id), warehouseName: row.warehouse_name,
      merchantName: row.merchant_name, lotId: bufferToUuid(row.lot_id), lotNumber: row.lot_number,
      receivedAt: iso(row.received_at), soldAt: iso(row.sold_at),
      warrantyStartsAt: row.warranty_starts_at ? iso(row.warranty_starts_at).slice(0, 10) : null,
      warrantyEndsAt: row.warranty_ends_at ? iso(row.warranty_ends_at).slice(0, 10) : null
    })),
    total: Number(countRows[0].total)
  };
}

export async function summarizeTraceabilitySerials({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS total, SUM(status = 'AVAILABLE') AS available,
            SUM(status = 'RESERVED') AS reserved, SUM(status = 'QUARANTINED') AS quarantined,
            SUM(status = 'SOLD') AS sold, SUM(status = 'SCRAPPED') AS scrapped
       FROM serial_numbers WHERE tenant_id = ?`, [uuidToBuffer(tenantId)]
  );
  const row = rows[0];
  return { total: number(row.total) || 0, available: number(row.available) || 0,
    reserved: number(row.reserved) || 0, quarantined: number(row.quarantined) || 0,
    sold: number(row.sold) || 0, scrapped: number(row.scrapped) || 0 };
}

export async function findSerialContext({ tenantId, serialId, connection, forUpdate = false }) {
  const [rows] = await connection.execute(
    `SELECT sn.id, sn.inventory_balance_id, sn.inventory_lot_id, sn.serial_number, sn.status,
            ib.warehouse_id, ib.on_hand_quantity, ib.reserved_quantity, ib.quarantine_quantity,
            p.name AS product_name, pv.sku, w.name AS warehouse_name
       FROM serial_numbers sn
       JOIN inventory_balances ib ON ib.id = sn.inventory_balance_id
       JOIN seller_offers so ON so.id = ib.offer_id
       JOIN product_variants pv ON pv.id = so.variant_id
       JOIN products p ON p.id = pv.product_id
       JOIN warehouses w ON w.id = ib.warehouse_id
      WHERE sn.tenant_id = ? AND sn.id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(serialId)]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return { id: bufferToUuid(row.id), balanceId: bufferToUuid(row.inventory_balance_id),
    lotId: bufferToUuid(row.inventory_lot_id), serialNumber: row.serial_number, status: row.status,
    warehouseId: bufferToUuid(row.warehouse_id), warehouseName: row.warehouse_name,
    productName: row.product_name, sku: row.sku, onHandQuantity: number(row.on_hand_quantity),
    reservedQuantity: number(row.reserved_quantity), quarantineQuantity: number(row.quarantine_quantity) };
}

export async function updateSerialStatus({ serialId, status, connection }) {
  await connection.execute("UPDATE serial_numbers SET status = ? WHERE id = ?", [status, uuidToBuffer(serialId)]);
}

export async function updateBalanceTraceability({ balanceId, quantityDelta, quarantineDelta, connection }) {
  const [result] = await connection.execute(
    `UPDATE inventory_balances
        SET on_hand_quantity = on_hand_quantity + ?,
            quarantine_quantity = quarantine_quantity + ?, version = version + 1,
            last_movement_at = UTC_TIMESTAMP(6)
      WHERE id = ? AND on_hand_quantity + ? >= 0 AND quarantine_quantity + ? >= 0
        AND on_hand_quantity + ? >= reserved_quantity + quarantine_quantity + ?`,
    [quantityDelta, quarantineDelta, uuidToBuffer(balanceId), quantityDelta, quarantineDelta,
      quantityDelta, quarantineDelta]
  );
  return result.affectedRows === 1;
}

export async function updateLotTraceability({ lotId, quantityDelta, quarantineDelta, connection }) {
  const [result] = await connection.execute(
    `UPDATE inventory_lots
        SET on_hand_quantity = on_hand_quantity + ?,
            quarantine_quantity = quarantine_quantity + ?, version = version + 1
      WHERE id = ? AND on_hand_quantity + ? >= 0 AND quarantine_quantity + ? >= 0
        AND on_hand_quantity + ? >= reserved_quantity + quarantine_quantity + ?`,
    [quantityDelta, quarantineDelta, uuidToBuffer(lotId), quantityDelta, quarantineDelta,
      quantityDelta, quarantineDelta]
  );
  return result.affectedRows === 1;
}

export async function findBalanceContext({
  tenantId,
  balanceId,
  connection = getPrimaryPool(),
  forUpdate = false
}) {
  const [rows] = await connection.execute(
    `SELECT ib.id, ib.warehouse_id, ib.offer_id, ib.on_hand_quantity, ib.reserved_quantity,
            ib.quarantine_quantity, ib.safety_stock_quantity, ib.reorder_point_quantity,
            ib.reorder_quantity, p.name AS product_name, pv.sku, w.name AS warehouse_name,
            w.merchant_id, pt.lot_tracking_enabled, pt.serial_tracking_enabled,
            pt.expiry_tracking_enabled
       FROM inventory_balances ib JOIN seller_offers so ON so.id = ib.offer_id
       JOIN product_variants pv ON pv.id = so.variant_id JOIN products p ON p.id = pv.product_id
       JOIN product_types pt ON pt.id = p.product_type_id JOIN warehouses w ON w.id = ib.warehouse_id
      WHERE ib.tenant_id = ? AND ib.id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(balanceId)]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return { id: bufferToUuid(row.id), warehouseId: bufferToUuid(row.warehouse_id),
    offerId: bufferToUuid(row.offer_id), merchantId: bufferToUuid(row.merchant_id),
    productName: row.product_name, sku: row.sku, warehouseName: row.warehouse_name,
    onHandQuantity: number(row.on_hand_quantity), reservedQuantity: number(row.reserved_quantity),
    quarantineQuantity: number(row.quarantine_quantity), safetyStockQuantity: number(row.safety_stock_quantity),
    reorderPointQuantity: number(row.reorder_point_quantity), reorderQuantity: number(row.reorder_quantity),
    lotTrackingEnabled: Boolean(row.lot_tracking_enabled),
    serialTrackingEnabled: Boolean(row.serial_tracking_enabled),
    expiryTrackingEnabled: Boolean(row.expiry_tracking_enabled) };
}

export async function updateStockPolicy({ balanceId, policy, connection }) {
  await connection.execute(
    `UPDATE inventory_balances SET safety_stock_quantity = ?, reorder_point_quantity = ?,
       reorder_quantity = ?, version = version + 1 WHERE id = ?`,
    [policy.safetyStockQuantity, policy.reorderPointQuantity, policy.reorderQuantity,
      uuidToBuffer(balanceId)]
  );
}

export async function insertTransfer({ transfer, connection }) {
  await connection.execute(
    `INSERT INTO stock_transfers (id, tenant_id, transfer_number, source_warehouse_id,
       destination_warehouse_id, status, requested_by, approved_by, dispatched_at,
       received_at, notes) VALUES (?, ?, ?, ?, ?, 'RECEIVED', ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), ?)`,
    [uuidToBuffer(transfer.id), uuidToBuffer(transfer.tenantId), transfer.number,
      uuidToBuffer(transfer.sourceWarehouseId), uuidToBuffer(transfer.destinationWarehouseId),
      uuidToBuffer(transfer.userId), uuidToBuffer(transfer.userId), transfer.notes]
  );
}

export async function insertTransferItem({ item, connection }) {
  await connection.execute(
    `INSERT INTO stock_transfer_items (id, transfer_id, offer_id, source_lot_id,
       requested_quantity, dispatched_quantity, received_quantity, damaged_quantity)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [uuidToBuffer(item.id), uuidToBuffer(item.transferId), uuidToBuffer(item.offerId),
      item.sourceLotId ? uuidToBuffer(item.sourceLotId) : null, item.quantity,
      item.quantity, item.quantity]
  );
}

export async function listBalanceLots({ tenantId, balanceId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT id, lot_number, manufactured_at, expires_at, on_hand_quantity, reserved_quantity,
            quarantine_quantity, unit_cost FROM inventory_lots
      WHERE tenant_id = ? AND inventory_balance_id = ? AND status = 'ACTIVE'
      ORDER BY expires_at IS NULL, expires_at, received_at`,
    [uuidToBuffer(tenantId), uuidToBuffer(balanceId)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), lotNumber: row.lot_number,
    manufacturedAt: row.manufactured_at ? iso(row.manufactured_at).slice(0, 10) : null,
    expiresAt: row.expires_at ? iso(row.expires_at).slice(0, 10) : null,
    onHandQuantity: number(row.on_hand_quantity), reservedQuantity: number(row.reserved_quantity),
    quarantineQuantity: number(row.quarantine_quantity), unitCost: number(row.unit_cost) }));
}

export async function listBalanceSerials({ tenantId, balanceId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT sn.id, sn.serial_number, sn.secondary_identifier, sn.inventory_lot_id,
            il.lot_number, sn.received_at
       FROM serial_numbers sn
       LEFT JOIN inventory_lots il ON il.id = sn.inventory_lot_id
      WHERE sn.tenant_id = ? AND sn.inventory_balance_id = ? AND sn.status = 'AVAILABLE'
      ORDER BY sn.received_at, sn.serial_number`,
    [uuidToBuffer(tenantId), uuidToBuffer(balanceId)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), serialNumber: row.serial_number,
    secondaryIdentifier: row.secondary_identifier, lotId: bufferToUuid(row.inventory_lot_id),
    lotNumber: row.lot_number, receivedAt: iso(row.received_at) }));
}

export async function findTransferSerials({ tenantId, balanceId, serialIds, connection }) {
  if (!serialIds.length) return [];
  const placeholders = serialIds.map(() => "?").join(", ");
  const [rows] = await connection.execute(
    `SELECT sn.id, sn.serial_number, sn.status, sn.inventory_lot_id,
            il.lot_number, il.manufactured_at, il.expires_at, il.unit_cost
       FROM serial_numbers sn
       LEFT JOIN inventory_lots il ON il.id = sn.inventory_lot_id
      WHERE sn.tenant_id = ? AND sn.inventory_balance_id = ?
        AND sn.id IN (${placeholders}) FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(balanceId), ...serialIds.map(uuidToBuffer)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), serialNumber: row.serial_number,
    status: row.status, lotId: bufferToUuid(row.inventory_lot_id), lotNumber: row.lot_number,
    manufacturedAt: row.manufactured_at ? iso(row.manufactured_at).slice(0, 10) : null,
    expiresAt: row.expires_at ? iso(row.expires_at).slice(0, 10) : null,
    unitCost: number(row.unit_cost) }));
}

export async function updateSerialLocation({ serialId, balanceId, lotId, connection }) {
  await connection.execute(
    `UPDATE serial_numbers SET inventory_balance_id = ?, inventory_lot_id = ? WHERE id = ?`,
    [uuidToBuffer(balanceId), lotId ? uuidToBuffer(lotId) : null, uuidToBuffer(serialId)]
  );
}

export async function insertAdjustment({ adjustment, connection }) {
  await connection.execute(
    `INSERT INTO stock_adjustments (id, tenant_id, warehouse_id, adjustment_number, status,
       reason_code, notes, approved_by, approved_at, posted_at, created_by)
     VALUES (?, ?, ?, ?, 'POSTED', ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), ?)`,
    [uuidToBuffer(adjustment.id), uuidToBuffer(adjustment.tenantId), uuidToBuffer(adjustment.warehouseId),
      adjustment.number, adjustment.reasonCode, adjustment.notes, uuidToBuffer(adjustment.userId),
      uuidToBuffer(adjustment.userId)]
  );
}

export async function insertAdjustmentItem({ item, connection }) {
  await connection.execute(
    `INSERT INTO stock_adjustment_items (id, adjustment_id, inventory_balance_id, inventory_lot_id,
       serial_number_id, system_quantity, counted_quantity, quantity_delta, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(item.id), uuidToBuffer(item.adjustmentId), uuidToBuffer(item.balanceId),
      item.lotId ? uuidToBuffer(item.lotId) : null,
      item.serialId ? uuidToBuffer(item.serialId) : null, item.systemQuantity, item.countedQuantity,
      item.delta, item.notes]
  );
}

export async function insertLedger({ entry, connection }) {
  await connection.execute(
    `INSERT INTO stock_ledger_entries (id, tenant_id, inventory_balance_id, inventory_lot_id,
       serial_number_id, movement_type, quantity_delta, quarantine_delta, unit_cost,
       reference_type, reference_id, reason_code, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(entry.id), uuidToBuffer(entry.tenantId), uuidToBuffer(entry.balanceId),
      entry.lotId ? uuidToBuffer(entry.lotId) : null,
      entry.serialId ? uuidToBuffer(entry.serialId) : null, entry.movementType, entry.delta,
      entry.quarantineDelta || 0, entry.unitCost, entry.referenceType,
      uuidToBuffer(entry.referenceId), entry.reasonCode || null,
      entry.notes || null, uuidToBuffer(entry.userId)]
  );
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(
    `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type,
       entity_id, request_id, ip_address, user_agent, after_data)
     VALUES (?, ?, ?, 'USER', ?, ?, ?, ?, INET6_ATON(?), ?, ?)`,
    [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId),
      audit.action, audit.entityType, uuidToBuffer(audit.entityId), audit.requestId,
      audit.ipAddress, audit.userAgent, JSON.stringify(audit.afterData)]
  );
}

export async function insertOutbox({ event, connection }) {
  await connection.execute(
    `INSERT INTO outbox_events (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(event.id), uuidToBuffer(event.tenantId), event.aggregateType,
      uuidToBuffer(event.aggregateId), event.type, JSON.stringify(event.payload)]
  );
}
