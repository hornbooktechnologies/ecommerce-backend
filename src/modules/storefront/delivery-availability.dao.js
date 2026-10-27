import { getPrimaryPool } from "../../database/pool-factory.js";
import { uuidToBuffer } from "../../core/identifiers/uuid.js";

// Same 30-day horizon, active-zone rules and cutoff boundary as checkout slots.
export async function deliveryAvailability({ tenantId, storeId, postalCode, connection = getPrimaryPool() }) {
  const [[row]] = await connection.execute(`SELECT COUNT(DISTINCT z.id) AS zones,
    COUNT(s.id) AS scheduled,
    COALESCE(SUM(s.status = 'OPEN' AND s.starts_at > DATE_ADD(UTC_TIMESTAMP(6), INTERVAL t.cutoff_minutes MINUTE)), 0) AS bookable,
    COALESCE(SUM(s.status = 'OPEN' AND s.starts_at > DATE_ADD(UTC_TIMESTAMP(6), INTERVAL t.cutoff_minutes MINUTE)
      AND s.reserved_orders < s.order_capacity AND (s.weight_capacity IS NULL OR s.reserved_weight < s.weight_capacity)), 0) AS available,
    MIN(CASE WHEN s.status = 'OPEN' AND s.starts_at > DATE_ADD(UTC_TIMESTAMP(6), INTERVAL t.cutoff_minutes MINUTE)
      AND s.reserved_orders < s.order_capacity AND (s.weight_capacity IS NULL OR s.reserved_weight < s.weight_capacity)
      THEN s.starts_at END) AS next_start
    FROM delivery_zones z
    LEFT JOIN delivery_slot_templates t ON t.delivery_zone_id = z.id AND t.tenant_id = z.tenant_id AND t.status = 'ACTIVE'
    LEFT JOIN delivery_slot_instances s ON s.template_id = t.id AND s.tenant_id = z.tenant_id AND s.delivery_zone_id = z.id
      AND s.starts_at > UTC_TIMESTAMP(6) AND s.starts_at < DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 DAY) AND s.ends_at > s.starts_at
    WHERE z.tenant_id = ? AND z.store_id = ? AND z.status = 'ACTIVE'
      AND (NOT EXISTS(SELECT 1 FROM delivery_zone_postal_codes p WHERE p.delivery_zone_id = z.id AND p.status = 'ACTIVE')
        OR EXISTS(SELECT 1 FROM delivery_zone_postal_codes p WHERE p.delivery_zone_id = z.id AND p.status = 'ACTIVE' AND p.postal_code = ?))`,
  [uuidToBuffer(tenantId), uuidToBuffer(storeId), postalCode]);
  return row;
}
