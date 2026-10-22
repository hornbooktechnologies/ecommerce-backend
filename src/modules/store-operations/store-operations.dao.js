import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";

const numeric = (value) => value === null || value === undefined ? null : Number(value);
const dateOnly = (value) => value ? new Date(value).toISOString().slice(0, 10) : null;
const dateTime = (value) => value ? new Date(value).toISOString() : null;

function mapStore(row) {
  return {
    id: bufferToUuid(row.id), code: row.code, name: row.name, legalName: row.legal_name,
    status: row.status, baseCurrency: row.base_currency, languageCode: row.language_code,
    timezone: row.timezone, supportEmail: row.support_email, supportPhone: row.support_phone,
    substitutionsEnabled: Boolean(row.substitutions_enabled), substitutionPolicy: row.substitution_policy,
    slotHorizonDays: Number(row.slot_horizon_days), addressId: bufferToUuid(row.business_address_id),
    line1: row.line1, line2: row.line2 || "", landmark: row.landmark || "", city: row.city,
    stateCode: row.state_code, stateName: row.state_name, postalCode: row.postal_code,
    zoneCount: Number(row.zone_count || 0), warehouseCount: Number(row.warehouse_count || 0),
    upcomingSlotCount: Number(row.upcoming_slot_count || 0), openCapacity: Number(row.open_capacity || 0),
    reservedOrders: Number(row.reserved_orders || 0), updatedAt: dateTime(row.updated_at)
  };
}

export async function listStores({ tenantId, search, status, page, pageSize, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const where = ["s.tenant_id = ?", "s.deleted_at IS NULL"];
  const params = [tenant];
  if (status !== "ALL") { where.push("s.status = ?"); params.push(status); }
  if (search) {
    where.push("(s.name LIKE ? OR s.code LIKE ? OR a.city LIKE ? OR a.postal_code LIKE ?)");
    const term = `%${search}%`; params.push(term, term, term, term);
  }
  const whereSql = where.join(" AND ");
  const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM stores s LEFT JOIN addresses a ON a.id = s.business_address_id WHERE ${whereSql}`, params);
  const offset = (page - 1) * pageSize;
  const [rows] = await connection.execute(
    `SELECT s.*, a.line1, a.line2, a.landmark, a.city, a.state_code, a.state_name, a.postal_code,
            (SELECT COUNT(*) FROM delivery_zones dz WHERE dz.store_id = s.id) AS zone_count,
            (SELECT COUNT(*) FROM warehouses w WHERE w.store_id = s.id AND w.deleted_at IS NULL) AS warehouse_count,
            (SELECT COUNT(*) FROM delivery_slot_instances dsi JOIN delivery_zones dz ON dz.id = dsi.delivery_zone_id
              WHERE dz.store_id = s.id AND dsi.slot_date >= UTC_DATE() AND dsi.status = 'OPEN') AS upcoming_slot_count,
            (SELECT COALESCE(SUM(dsi.order_capacity), 0) FROM delivery_slot_instances dsi
              JOIN delivery_zones dz ON dz.id = dsi.delivery_zone_id
              WHERE dz.store_id = s.id AND dsi.slot_date BETWEEN UTC_DATE() AND DATE_ADD(UTC_DATE(), INTERVAL 7 DAY)
                AND dsi.status = 'OPEN') AS open_capacity,
            (SELECT COALESCE(SUM(dsi.reserved_orders), 0) FROM delivery_slot_instances dsi
              JOIN delivery_zones dz ON dz.id = dsi.delivery_zone_id
              WHERE dz.store_id = s.id AND dsi.slot_date BETWEEN UTC_DATE() AND DATE_ADD(UTC_DATE(), INTERVAL 7 DAY)) AS reserved_orders
       FROM stores s LEFT JOIN addresses a ON a.id = s.business_address_id
      WHERE ${whereSql} ORDER BY s.status = 'ACTIVE' DESC, s.name LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { items: rows.map(mapStore), total: Number(count.total), page, pageSize,
    totalPages: Math.max(1, Math.ceil(Number(count.total) / pageSize)) };
}

export async function summarizeStores({ tenantId, connection = getPrimaryPool() }) {
  const [[row]] = await connection.execute(
    `SELECT COUNT(*) AS total_stores, SUM(s.status = 'ACTIVE') AS active_stores,
            (SELECT COUNT(*) FROM delivery_zones dz WHERE dz.tenant_id = ? AND dz.status = 'ACTIVE') AS active_zones,
            (SELECT COUNT(*) FROM delivery_slot_instances dsi WHERE dsi.tenant_id = ?
              AND dsi.slot_date >= UTC_DATE() AND dsi.status = 'OPEN') AS open_slots
       FROM stores s WHERE s.tenant_id = ? AND s.deleted_at IS NULL`,
    [uuidToBuffer(tenantId), uuidToBuffer(tenantId), uuidToBuffer(tenantId)]
  );
  return { totalStores: Number(row.total_stores || 0), activeStores: Number(row.active_stores || 0),
    activeZones: Number(row.active_zones || 0), openSlots: Number(row.open_slots || 0) };
}

export async function findStore({ tenantId, storeId, connection = getPrimaryPool(), forUpdate = false }) {
  const [rows] = await connection.execute(
    `SELECT s.*, a.line1, a.line2, a.landmark, a.city, a.state_code, a.state_name, a.postal_code,
            0 AS zone_count, 0 AS warehouse_count, 0 AS upcoming_slot_count, 0 AS open_capacity, 0 AS reserved_orders
       FROM stores s LEFT JOIN addresses a ON a.id = s.business_address_id
      WHERE s.tenant_id = ? AND s.id = ? AND s.deleted_at IS NULL LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(storeId)]
  );
  return rows[0] ? mapStore(rows[0]) : null;
}

export async function listZones({ tenantId, storeId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT dz.*,
            GROUP_CONCAT(dzp.postal_code ORDER BY dzp.postal_code SEPARATOR ',') AS postal_codes,
            (SELECT COUNT(*) FROM delivery_slot_templates dst WHERE dst.delivery_zone_id = dz.id) AS template_count
       FROM delivery_zones dz LEFT JOIN delivery_zone_postal_codes dzp ON dzp.delivery_zone_id = dz.id AND dzp.status = 'ACTIVE'
      WHERE dz.tenant_id = ? AND dz.store_id = ? GROUP BY dz.id ORDER BY dz.status = 'ACTIVE' DESC, dz.name`,
    [uuidToBuffer(tenantId), uuidToBuffer(storeId)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), storeId: bufferToUuid(row.store_id), name: row.name,
    status: row.status, minimumOrderAmount: numeric(row.minimum_order_amount), deliveryFee: numeric(row.delivery_fee),
    freeDeliveryThreshold: numeric(row.free_delivery_threshold), postalCodes: row.postal_codes ? row.postal_codes.split(",") : [],
    templateCount: Number(row.template_count || 0) }));
}

export async function listTemplates({ tenantId, storeId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT dst.*, dz.name AS zone_name FROM delivery_slot_templates dst
       JOIN delivery_zones dz ON dz.id = dst.delivery_zone_id
      WHERE dst.tenant_id = ? AND dz.store_id = ?
      ORDER BY dz.name, dst.day_of_week, dst.start_time`,
    [uuidToBuffer(tenantId), uuidToBuffer(storeId)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), zoneId: bufferToUuid(row.delivery_zone_id),
    zoneName: row.zone_name, name: row.name, dayOfWeek: Number(row.day_of_week),
    startTime: String(row.start_time).slice(0, 5), endTime: String(row.end_time).slice(0, 5),
    orderCapacity: Number(row.order_capacity), weightCapacity: numeric(row.weight_capacity),
    cutoffMinutes: Number(row.cutoff_minutes), status: row.status }));
}

export async function listUpcomingInstances({ tenantId, storeId, days = 14, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT dsi.*, dz.name AS zone_name, dst.name AS template_name
       FROM delivery_slot_instances dsi JOIN delivery_zones dz ON dz.id = dsi.delivery_zone_id
       JOIN delivery_slot_templates dst ON dst.id = dsi.template_id
      WHERE dsi.tenant_id = ? AND dz.store_id = ?
        AND dsi.slot_date BETWEEN UTC_DATE() AND DATE_ADD(UTC_DATE(), INTERVAL ? DAY)
      ORDER BY dsi.slot_date, dsi.starts_at LIMIT 250`,
    [uuidToBuffer(tenantId), uuidToBuffer(storeId), days]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), templateId: bufferToUuid(row.template_id),
    zoneId: bufferToUuid(row.delivery_zone_id), zoneName: row.zone_name, templateName: row.template_name,
    slotDate: dateOnly(row.slot_date), startsAt: dateTime(row.starts_at), endsAt: dateTime(row.ends_at),
    orderCapacity: Number(row.order_capacity), reservedOrders: Number(row.reserved_orders),
    weightCapacity: numeric(row.weight_capacity), reservedWeight: numeric(row.reserved_weight), status: row.status }));
}

export async function listWarehouses({ tenantId, storeId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT w.id, w.store_id, w.code, w.name, w.status, w.warehouse_type, a.city, a.postal_code,
            m.display_name AS merchant_name, m.merchant_type
       FROM warehouses w JOIN addresses a ON a.id = w.address_id JOIN merchants m ON m.id = w.merchant_id
      WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND m.merchant_type = 'FIRST_PARTY'
      ORDER BY w.store_id = ? DESC, w.name`, [uuidToBuffer(tenantId), uuidToBuffer(storeId)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), storeId: bufferToUuid(row.store_id), code: row.code,
    name: row.name, status: row.status, type: row.warehouse_type, city: row.city, postalCode: row.postal_code,
    merchantName: row.merchant_name, assigned: bufferToUuid(row.store_id) === storeId }));
}

export async function findFirstPartyMerchant({ tenantId, connection }) {
  const [rows] = await connection.execute(
    `SELECT id FROM merchants WHERE tenant_id = ? AND merchant_type = 'FIRST_PARTY'
      AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, [uuidToBuffer(tenantId)]
  );
  return rows[0] ? bufferToUuid(rows[0].id) : null;
}

export async function insertAddress({ address, connection }) {
  await connection.execute(
    `INSERT INTO addresses (id, tenant_id, company_name, line1, line2, landmark, city, state_code, state_name, postal_code, country_code, phone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN', ?)`,
    [uuidToBuffer(address.id), uuidToBuffer(address.tenantId), address.companyName, address.line1,
      address.line2 || null, address.landmark || null, address.city, address.stateCode, address.stateName,
      address.postalCode, address.phone || null]
  );
}

export async function insertStore({ store, connection }) {
  await connection.execute(
    `INSERT INTO stores (id, tenant_id, code, name, legal_name, status, business_address_id,
       support_email, support_phone, substitutions_enabled, substitution_policy, slot_horizon_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(store.id), uuidToBuffer(store.tenantId), store.code, store.name, store.legalName || null,
      store.status, uuidToBuffer(store.addressId), store.supportEmail || null, store.supportPhone || null,
      store.substitutionsEnabled ? 1 : 0, store.substitutionPolicy, store.slotHorizonDays]
  );
}

export async function insertStoreMerchant({ storeId, merchantId, connection }) {
  await connection.execute("INSERT INTO store_merchants (store_id, merchant_id, status) VALUES (?, ?, 'ACTIVE')",
    [uuidToBuffer(storeId), uuidToBuffer(merchantId)]);
}

export async function insertAdminChannel({ id, tenantId, storeId, connection }) {
  await connection.execute(
    `INSERT INTO sales_channels (id, tenant_id, store_id, code, name, channel_type, status)
     VALUES (?, ?, ?, 'ADMIN', 'Admin orders', 'ADMIN', 'ACTIVE')`,
    [uuidToBuffer(id), uuidToBuffer(tenantId), uuidToBuffer(storeId)]
  );
}

export async function updateStore({ storeId, input, connection }) {
  await connection.execute(
    `UPDATE stores SET name = ?, legal_name = ?, status = ?, support_email = ?, support_phone = ?,
       substitutions_enabled = ?, substitution_policy = ?, slot_horizon_days = ? WHERE id = ?`,
    [input.name, input.legalName || null, input.status, input.supportEmail || null, input.supportPhone || null,
      input.substitutionsEnabled ? 1 : 0, input.substitutionPolicy, input.slotHorizonDays, uuidToBuffer(storeId)]
  );
}

export async function updateAddress({ addressId, input, connection }) {
  await connection.execute(
    `UPDATE addresses SET company_name = ?, line1 = ?, line2 = ?, landmark = ?, city = ?, state_code = ?,
       state_name = ?, postal_code = ?, phone = ? WHERE id = ?`,
    [input.name, input.line1, input.line2 || null, input.landmark || null, input.city, input.stateCode,
      input.stateName, input.postalCode, input.supportPhone || null, uuidToBuffer(addressId)]
  );
}

export async function findZone({ tenantId, storeId, zoneId, connection, forUpdate = false }) {
  const [rows] = await connection.execute(
    `SELECT id, name, status FROM delivery_zones WHERE tenant_id = ? AND store_id = ? AND id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(storeId), uuidToBuffer(zoneId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), name: rows[0].name, status: rows[0].status } : null;
}

export async function insertZone({ zone, connection }) {
  await connection.execute(
    `INSERT INTO delivery_zones (id, tenant_id, store_id, name, status, minimum_order_amount, delivery_fee, free_delivery_threshold)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(zone.id), uuidToBuffer(zone.tenantId), uuidToBuffer(zone.storeId), zone.name, zone.status,
      zone.minimumOrderAmount, zone.deliveryFee, zone.freeDeliveryThreshold]
  );
}

export async function updateZone({ zoneId, input, connection }) {
  await connection.execute(
    `UPDATE delivery_zones SET name = ?, status = ?, minimum_order_amount = ?, delivery_fee = ?, free_delivery_threshold = ? WHERE id = ?`,
    [input.name, input.status, input.minimumOrderAmount, input.deliveryFee, input.freeDeliveryThreshold, uuidToBuffer(zoneId)]
  );
}

export async function replaceZonePostalCodes({ zoneId, postalCodes, connection }) {
  await connection.execute("DELETE FROM delivery_zone_postal_codes WHERE delivery_zone_id = ?", [uuidToBuffer(zoneId)]);
  for (const postalCode of postalCodes) {
    await connection.execute("INSERT INTO delivery_zone_postal_codes (delivery_zone_id, postal_code, status) VALUES (?, ?, 'ACTIVE')",
      [uuidToBuffer(zoneId), postalCode]);
  }
}

export async function findTemplate({ tenantId, storeId, templateId, connection, forUpdate = false }) {
  const [rows] = await connection.execute(
    `SELECT dst.id, dst.delivery_zone_id, dst.status FROM delivery_slot_templates dst
       JOIN delivery_zones dz ON dz.id = dst.delivery_zone_id
      WHERE dst.tenant_id = ? AND dz.store_id = ? AND dst.id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [uuidToBuffer(tenantId), uuidToBuffer(storeId), uuidToBuffer(templateId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), zoneId: bufferToUuid(rows[0].delivery_zone_id), status: rows[0].status } : null;
}

export async function insertTemplate({ template, connection }) {
  await connection.execute(
    `INSERT INTO delivery_slot_templates (id, tenant_id, delivery_zone_id, name, day_of_week, start_time,
       end_time, order_capacity, weight_capacity, cutoff_minutes, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(template.id), uuidToBuffer(template.tenantId), uuidToBuffer(template.zoneId), template.name,
      template.dayOfWeek, template.startTime, template.endTime, template.orderCapacity, template.weightCapacity,
      template.cutoffMinutes, template.status]
  );
}

export async function updateTemplate({ templateId, input, connection }) {
  await connection.execute(
    `UPDATE delivery_slot_templates SET delivery_zone_id = ?, name = ?, day_of_week = ?, start_time = ?, end_time = ?,
       order_capacity = ?, weight_capacity = ?, cutoff_minutes = ?, status = ? WHERE id = ?`,
    [uuidToBuffer(input.zoneId), input.name, input.dayOfWeek, input.startTime, input.endTime,
      input.orderCapacity, input.weightCapacity, input.cutoffMinutes, input.status, uuidToBuffer(templateId)]
  );
  if (input.status !== "ACTIVE") {
    await connection.execute("UPDATE delivery_slot_instances SET status = 'CLOSED' WHERE template_id = ? AND slot_date >= UTC_DATE() AND reserved_orders = 0",
      [uuidToBuffer(templateId)]);
  }
}

export async function listActiveTemplates({ tenantId, storeId, connection }) {
  const [rows] = await connection.execute(
    `SELECT dst.* FROM delivery_slot_templates dst JOIN delivery_zones dz ON dz.id = dst.delivery_zone_id
      WHERE dst.tenant_id = ? AND dz.store_id = ? AND dst.status = 'ACTIVE' AND dz.status = 'ACTIVE'`,
    [uuidToBuffer(tenantId), uuidToBuffer(storeId)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), zoneId: bufferToUuid(row.delivery_zone_id),
    dayOfWeek: Number(row.day_of_week), startTime: String(row.start_time), endTime: String(row.end_time),
    orderCapacity: Number(row.order_capacity), weightCapacity: numeric(row.weight_capacity) }));
}

export async function insertSlotInstance({ instance, connection }) {
  const [result] = await connection.execute(
    `INSERT IGNORE INTO delivery_slot_instances (id, tenant_id, template_id, delivery_zone_id, slot_date,
       starts_at, ends_at, order_capacity, weight_capacity, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
    [uuidToBuffer(instance.id), uuidToBuffer(instance.tenantId), uuidToBuffer(instance.templateId),
      uuidToBuffer(instance.zoneId), instance.slotDate, instance.startsAt, instance.endsAt,
      instance.orderCapacity, instance.weightCapacity]
  );
  return result.affectedRows;
}

export async function assignWarehouses({ tenantId, storeId, warehouseIds, connection }) {
  await connection.execute("UPDATE warehouses SET store_id = NULL WHERE tenant_id = ? AND store_id = ? AND deleted_at IS NULL",
    [uuidToBuffer(tenantId), uuidToBuffer(storeId)]);
  for (const warehouseId of warehouseIds) {
    await connection.execute(
      `UPDATE warehouses w JOIN merchants m ON m.id = w.merchant_id
          SET w.store_id = ? WHERE w.tenant_id = ? AND w.id = ? AND w.deleted_at IS NULL AND m.merchant_type = 'FIRST_PARTY'`,
      [uuidToBuffer(storeId), uuidToBuffer(tenantId), uuidToBuffer(warehouseId)]
    );
  }
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(
    `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type, entity_id,
       request_id, ip_address, user_agent, after_data) VALUES (?, ?, ?, 'USER', ?, ?, ?, ?, INET6_ATON(?), ?, ?)`,
    [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), uuidToBuffer(audit.actorUserId), audit.action,
      audit.entityType, uuidToBuffer(audit.entityId), audit.requestId, audit.ipAddress,
      audit.userAgent, JSON.stringify(audit.afterData)]
  );
}
