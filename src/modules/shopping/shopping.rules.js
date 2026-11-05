// e = inbox event; n = recipient. A cancelled/re-armed alert must never expose an old queued delivery.
export const shoppingNotificationVisible=`EXISTS(SELECT 1 FROM shopping_alert_events ae
 JOIN shopping_alert_subscriptions sub ON sub.id=ae.subscription_id AND sub.tenant_id=ae.tenant_id AND sub.cycle_id=ae.cycle_id
 JOIN seller_offers so ON so.id=sub.offer_id AND so.tenant_id=sub.tenant_id AND so.store_id=sub.store_id AND so.status='ACTIVE' AND so.deleted_at IS NULL
 JOIN product_variants pv ON pv.id=so.variant_id AND pv.tenant_id=sub.tenant_id AND pv.status='ACTIVE' AND pv.deleted_at IS NULL
 JOIN products p ON p.id=pv.product_id AND p.tenant_id=sub.tenant_id AND p.publication_status='PUBLISHED' AND p.approval_status='APPROVED' AND p.deleted_at IS NULL
 JOIN product_types pt ON pt.id=p.product_type_id AND pt.tenant_id=p.tenant_id AND pt.deleted_at IS NULL
 JOIN tenant_product_verticals tpv ON tpv.tenant_id=p.tenant_id AND tpv.vertical=pt.vertical AND tpv.status='ACTIVE'
 JOIN merchants m ON m.id=so.merchant_id AND m.tenant_id=sub.tenant_id AND m.status='ACTIVE' AND m.deleted_at IS NULL
 JOIN store_merchants sm ON sm.store_id=sub.store_id AND sm.merchant_id=m.id AND sm.status='ACTIVE'
 WHERE ae.id=e.entity_id AND ae.tenant_id=e.tenant_id AND sub.store_id=e.store_id AND sub.customer_id=n.recipient_id
 AND sub.status IN ('ACTIVE','TRIGGERED') AND sub.expires_at>UTC_TIMESTAMP(6)
 AND (m.merchant_type='FIRST_PARTY' OR EXISTS(SELECT 1 FROM vendor_profiles vp WHERE vp.merchant_id=m.id AND vp.tenant_id=m.tenant_id AND vp.onboarding_status='APPROVED')))`;
