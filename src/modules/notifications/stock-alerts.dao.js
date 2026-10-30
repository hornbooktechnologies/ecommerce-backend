import { getPrimaryPool } from "../../database/pool-factory.js";
import { uuidToBuffer as id, bufferToUuid as uuid } from "../../core/identifiers/uuid.js";

// Shared by event generation and read-time inbox visibility. Every join is tenant scoped.
export const stockSourceJoins = `
  JOIN warehouses w ON w.id = ib.warehouse_id AND w.tenant_id = ib.tenant_id
  JOIN seller_offers so ON so.id = ib.offer_id AND so.tenant_id = ib.tenant_id AND so.merchant_id = w.merchant_id
  JOIN product_variants pv ON pv.id = so.variant_id AND pv.tenant_id = ib.tenant_id
  JOIN products p ON p.id = pv.product_id AND p.tenant_id = ib.tenant_id
  JOIN merchants m ON m.id = so.merchant_id AND m.tenant_id = ib.tenant_id
  JOIN stores s ON s.id = so.store_id AND s.tenant_id = ib.tenant_id
  JOIN tenants t ON t.id = ib.tenant_id`;
export const stockSourceEligible = `t.status = 'ACTIVE' AND t.deleted_at IS NULL
  AND w.status = 'ACTIVE' AND w.deleted_at IS NULL
  AND so.status = 'ACTIVE' AND so.deleted_at IS NULL
  AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL AND p.deleted_at IS NULL
  AND p.publication_status <> 'ARCHIVED' AND p.product_kind <> 'BUNDLE'
  AND m.status = 'ACTIVE' AND m.deleted_at IS NULL
  AND s.status = 'ACTIVE' AND s.deleted_at IS NULL`;

export async function candidates({ afterId = null, limit = 100, connection = getPrimaryPool() } = {}) {
  const [rows] = await connection.execute(`SELECT ib.id, ib.tenant_id FROM inventory_balances ib
    LEFT JOIN inventory_alert_states st ON st.balance_id = ib.id AND st.tenant_id = ib.tenant_id
    WHERE (ib.reorder_point_quantity IS NOT NULL OR st.balance_id IS NOT NULL)
      ${afterId ? "AND ib.id > ?" : ""} ORDER BY ib.id LIMIT ?`, [...(afterId ? [id(afterId)] : []), limit]);
  return rows.map(row => ({ balanceId: uuid(row.id), tenantId: uuid(row.tenant_id) }));
}

export async function lockBalance({ tenantId, balanceId, connection }) {
  // Lock only this balance; never hold a whole page of stock locks.
  const [[row]] = await connection.execute(`SELECT id, on_hand_quantity, reserved_quantity,
    quarantine_quantity, reorder_point_quantity FROM inventory_balances
    WHERE tenant_id = ? AND id = ? FOR UPDATE`, [id(tenantId), id(balanceId)]);
  return row ? { onHand: row.on_hand_quantity, reserved: row.reserved_quantity,
    quarantine: row.quarantine_quantity, threshold: row.reorder_point_quantity } : null;
}

export async function source({ tenantId, balanceId, connection }) {
  const [[row]] = await connection.execute(`SELECT so.store_id, p.name AS product_name, pv.sku,
    w.name AS warehouse_name, m.display_name AS merchant_name
    FROM inventory_balances ib ${stockSourceJoins}
    WHERE ib.tenant_id = ? AND ib.id = ? AND ${stockSourceEligible}`, [id(tenantId), id(balanceId)]);
  return row ? { storeId: uuid(row.store_id), productName: row.product_name, sku: row.sku,
    warehouseName: row.warehouse_name, merchantName: row.merchant_name } : null;
}

export async function state({ tenantId, balanceId, connection }) {
  const [[row]] = await connection.execute(`SELECT is_low FROM inventory_alert_states
    WHERE tenant_id = ? AND balance_id = ? FOR UPDATE`, [id(tenantId), id(balanceId)]);
  return row ? { low: Boolean(row.is_low) } : null;
}

export async function saveState({ tenantId, balanceId, low, episodeId = null, connection }) {
  await connection.execute(`INSERT INTO inventory_alert_states (balance_id, tenant_id, is_low, episode_id)
    VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE is_low = VALUES(is_low),
    episode_id = VALUES(episode_id), checked_at = UTC_TIMESTAMP(6)`,
  [id(balanceId), id(tenantId), low ? 1 : 0, episodeId ? id(episodeId) : null]);
}

export async function summary(connection = getPrimaryPool()) {
  const [[row]] = await connection.execute(`SELECT COUNT(*) AS tracked,
    COALESCE(SUM(is_low),0) AS open_episodes, MAX(checked_at) AS last_transition
    FROM inventory_alert_states`);
  return { tracked: Number(row.tracked), openEpisodes: Number(row.open_episodes), lastTransition: row.last_transition };
}
