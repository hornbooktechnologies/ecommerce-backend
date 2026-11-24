import { getPrimaryPool } from "../../database/pool-factory.js";
import { uuidToBuffer } from "../../core/identifiers/uuid.js";

// Prefer an exact PIN over a catch-all zone. Never silently choose between two matching tariffs.
export async function deliveryAvailability({ tenantId, storeId, postalCode, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT z.id,z.delivery_days AS deliveryDays, z.delivery_fee AS deliveryFee,
      z.minimum_order_amount AS minimumOrderAmount, z.free_delivery_threshold AS freeDeliveryThreshold,
      EXISTS(SELECT 1 FROM delivery_zone_postal_codes p WHERE p.delivery_zone_id=z.id
        AND p.status='ACTIVE' AND p.postal_code=?) AS exactPin
    FROM delivery_zones z WHERE z.tenant_id=? AND z.store_id=? AND z.status='ACTIVE'
    HAVING exactPin=1 OR NOT EXISTS(SELECT 1 FROM delivery_zone_postal_codes p WHERE p.delivery_zone_id=z.id AND p.status='ACTIVE')
    ORDER BY exactPin DESC, z.id LIMIT 2`, [postalCode, uuidToBuffer(tenantId), uuidToBuffer(storeId)]);
  return rows.length && rows[0].exactPin !== rows[1]?.exactPin ? rows[0] : null;
}
