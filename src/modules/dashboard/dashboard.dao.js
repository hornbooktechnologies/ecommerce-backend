import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";

const number = (value) => value === null || value === undefined ? 0 : Number(value);
const iso = (value) => value ? new Date(value).toISOString() : null;

export async function getDashboardOverview({ tenantId, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const [metricResult, trendResult, mixResult, queueResult, activityResult] = await Promise.all([
    connection.execute(
      `SELECT
        (SELECT COUNT(*) FROM customer_orders co WHERE co.tenant_id = ?
          AND co.created_at >= UTC_DATE() AND co.status <> 'DRAFT') AS orders_today,
        (SELECT COUNT(*) FROM customer_orders co WHERE co.tenant_id = ?
          AND co.created_at >= DATE_SUB(UTC_DATE(), INTERVAL 1 DAY) AND co.created_at < UTC_DATE()
          AND co.status <> 'DRAFT') AS orders_yesterday,
        (SELECT COUNT(*) FROM customer_orders co WHERE co.tenant_id = ?
          AND co.status NOT IN ('DRAFT','CANCELLED','COMPLETED')
          AND co.fulfillment_status IN ('UNFULFILLED','PARTIALLY_FULFILLED')) AS awaiting_fulfillment,
        (SELECT COUNT(*) FROM inventory_balances ib WHERE ib.tenant_id = ?
          AND ib.reorder_point_quantity IS NOT NULL
          AND (ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity) <= ib.reorder_point_quantity) AS low_stock,
        (SELECT COUNT(*) FROM merchants m WHERE m.tenant_id = ? AND m.merchant_type = 'MARKETPLACE'
          AND m.status = 'PENDING' AND m.deleted_at IS NULL) AS pending_vendors,
        (SELECT COUNT(*) FROM return_requests rr WHERE rr.tenant_id = ? AND rr.status = 'REQUESTED') AS pending_returns,
        (SELECT COALESCE(SUM(co.grand_total), 0) FROM customer_orders co WHERE co.tenant_id = ?
          AND co.created_at >= DATE_SUB(UTC_DATE(), INTERVAL 29 DAY)
          AND co.status NOT IN ('DRAFT','CANCELLED')) AS revenue_30d`,
      [tenant, tenant, tenant, tenant, tenant, tenant, tenant]
    ),
    connection.execute(
      `SELECT calendar.day,
              COUNT(co.id) AS order_count,
              COALESCE(SUM(CASE WHEN co.status NOT IN ('DRAFT','CANCELLED') THEN co.grand_total ELSE 0 END), 0) AS revenue
         FROM (
           SELECT DATE_SUB(UTC_DATE(), INTERVAL 6 DAY) AS day UNION ALL
           SELECT DATE_SUB(UTC_DATE(), INTERVAL 5 DAY) UNION ALL
           SELECT DATE_SUB(UTC_DATE(), INTERVAL 4 DAY) UNION ALL
           SELECT DATE_SUB(UTC_DATE(), INTERVAL 3 DAY) UNION ALL
           SELECT DATE_SUB(UTC_DATE(), INTERVAL 2 DAY) UNION ALL
           SELECT DATE_SUB(UTC_DATE(), INTERVAL 1 DAY) UNION ALL
           SELECT UTC_DATE()
         ) calendar
         LEFT JOIN customer_orders co ON co.tenant_id = ? AND DATE(co.created_at) = calendar.day AND co.status <> 'DRAFT'
        GROUP BY calendar.day ORDER BY calendar.day`, [tenant]
    ),
    connection.execute(
      `SELECT status_group, COUNT(*) AS total FROM (
         SELECT CASE
           WHEN status = 'PLACED' THEN 'New'
           WHEN status IN ('CONFIRMED','PROCESSING') THEN 'Processing'
           WHEN status = 'COMPLETED' THEN 'Completed'
           WHEN status = 'CANCELLED' THEN 'Cancelled'
           ELSE 'Draft'
         END AS status_group
         FROM customer_orders WHERE tenant_id = ?
       ) grouped GROUP BY status_group
       ORDER BY FIELD(status_group, 'New', 'Processing', 'Completed', 'Cancelled', 'Draft')`, [tenant]
    ),
    connection.execute(
      `SELECT * FROM (
         SELECT 'VENDOR' AS item_type, m.merchant_code AS reference,
                'Vendor onboarding approval' AS work_item, m.display_name AS owner,
                m.created_at, 'REVIEW' AS queue_status
           FROM merchants m WHERE m.tenant_id = ? AND m.merchant_type = 'MARKETPLACE'
            AND m.status = 'PENDING' AND m.deleted_at IS NULL
         UNION ALL
         SELECT 'ORDER', co.order_number, 'Order awaiting fulfilment', s.name,
                co.created_at, 'ACTION'
           FROM customer_orders co JOIN stores s ON s.id = co.store_id
          WHERE co.tenant_id = ? AND co.status NOT IN ('DRAFT','CANCELLED','COMPLETED')
            AND co.fulfillment_status IN ('UNFULFILLED','PARTIALLY_FULFILLED')
         UNION ALL
         SELECT 'RETURN', rr.return_number, CONCAT(rr.return_type, ' return review'), co.order_number,
                rr.requested_at, 'REVIEW'
           FROM return_requests rr JOIN customer_orders co ON co.id = rr.customer_order_id
          WHERE rr.tenant_id = ? AND rr.status = 'REQUESTED'
         UNION ALL
         SELECT 'INVENTORY', pv.sku, CONCAT(p.name, ' below reorder level'), w.name,
                COALESCE(ib.last_movement_at, ib.updated_at), 'RISK'
           FROM inventory_balances ib JOIN seller_offers so ON so.id = ib.offer_id
           JOIN product_variants pv ON pv.id = so.variant_id JOIN products p ON p.id = pv.product_id
           JOIN warehouses w ON w.id = ib.warehouse_id
          WHERE ib.tenant_id = ? AND ib.reorder_point_quantity IS NOT NULL
            AND (ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity) <= ib.reorder_point_quantity
       ) queue ORDER BY FIELD(queue_status, 'RISK', 'ACTION', 'REVIEW'), created_at LIMIT 6`,
      [tenant, tenant, tenant, tenant]
    ),
    connection.execute(
      `SELECT al.id, al.action, al.entity_type, al.entity_id, al.after_data, al.occurred_at,
              CONCAT_WS(' ', u.first_name, u.last_name) AS actor_name
         FROM audit_logs al LEFT JOIN users u ON u.id = al.actor_user_id
        WHERE al.tenant_id = ? ORDER BY al.occurred_at DESC LIMIT 6`, [tenant]
    )
  ]);

  const metrics = metricResult[0][0];
  return {
    metrics: {
      ordersToday: number(metrics.orders_today), ordersYesterday: number(metrics.orders_yesterday),
      awaitingFulfillment: number(metrics.awaiting_fulfillment), lowStock: number(metrics.low_stock),
      pendingApprovals: number(metrics.pending_vendors) + number(metrics.pending_returns),
      pendingVendors: number(metrics.pending_vendors), pendingReturns: number(metrics.pending_returns),
      revenue30d: number(metrics.revenue_30d)
    },
    salesTrend: trendResult[0].map((row) => ({
      date: new Date(row.day).toISOString().slice(0, 10), orders: number(row.order_count), revenue: number(row.revenue)
    })),
    orderMix: mixResult[0].map((row) => ({ label: row.status_group, value: number(row.total) })),
    queue: queueResult[0].map((row, index) => ({ id: `${row.item_type}-${row.reference}-${index}`,
      type: row.item_type, reference: row.reference, work: row.work_item, owner: row.owner,
      createdAt: iso(row.created_at), status: row.queue_status })),
    activity: activityResult[0].map((row) => ({ id: bufferToUuid(row.id), action: row.action,
      entityType: row.entity_type, entityId: bufferToUuid(row.entity_id), actorName: row.actor_name || "System",
      occurredAt: iso(row.occurred_at), afterData: row.after_data || null }))
  };
}
