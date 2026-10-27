import { createId, uuidToBuffer as id } from "../../src/core/identifiers/uuid.js";

// Test-only helper: callers must roll back their transaction; never seeds live data.
export async function checkoutFixture(connection, scope) {
  const zoneId = createId(), templateId = createId(), slotId = createId(), promotionId = createId(), couponId = createId();
  const couponCode = `TEST${couponId.replaceAll("-", "").slice(-16).toUpperCase()}`;
  await connection.execute("INSERT INTO delivery_zones (id, tenant_id, store_id, name, delivery_fee) VALUES (?, ?, ?, 'Rollback checkout zone', 29)", [id(zoneId), id(scope.tenantId), id(scope.storeId)]);
  await connection.execute("INSERT INTO delivery_zone_postal_codes (delivery_zone_id, postal_code) VALUES (?, '560001')", [id(zoneId)]);
  await connection.execute("INSERT INTO delivery_slot_templates (id, tenant_id, delivery_zone_id, name, day_of_week, start_time, end_time, order_capacity, cutoff_minutes) VALUES (?, ?, ?, 'Rollback template', 1, '09:00:00', '11:00:00', 5, 60)", [id(templateId), id(scope.tenantId), id(zoneId)]);
  await connection.execute("INSERT INTO delivery_slot_instances (id, tenant_id, template_id, delivery_zone_id, slot_date, starts_at, ends_at, order_capacity) VALUES (?, ?, ?, ?, DATE_ADD(UTC_DATE(), INTERVAL 2 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 DAY), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 49 HOUR), 5)", [id(slotId), id(scope.tenantId), id(templateId), id(zoneId)]);
  const [[actor]] = await connection.execute("SELECT id FROM users WHERE deleted_at IS NULL LIMIT 1");
  await connection.execute(`INSERT INTO promotions (id, tenant_id, store_id, name, promotion_type, status, starts_at,
    usage_limit_total, usage_limit_per_customer, conditions_json, actions_json, created_by)
    VALUES (?, ?, ?, 'Rollback checkout coupon', 'FIXED_AMOUNT', 'ACTIVE', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY),
    1, 1, ?, ?, ?)`, [id(promotionId), id(scope.tenantId), id(scope.storeId), JSON.stringify({ minimumOrderAmount: 0, couponRequired: true }), JSON.stringify({ discountValue: 10 }), actor.id]);
  await connection.execute("INSERT INTO coupons (id, tenant_id, promotion_id, code, usage_limit) VALUES (?, ?, ?, ?, 1)", [id(couponId), id(scope.tenantId), id(promotionId), couponCode]);
  return { zoneId, slotId, templateId, couponCode, couponId, promotionId };
}
