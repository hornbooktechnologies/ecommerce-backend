// Used by every inbox read/count/mutation. Opt-out, re-arm, removal or checkout
// invalidates queued AND delivered reminders instead of exposing stale nudges.
export const reminderVisible=`EXISTS(SELECT 1 FROM shopping_reminder_events re
 JOIN shopping_reminder_preferences rp ON rp.id=re.preference_id AND rp.tenant_id=re.tenant_id AND rp.cycle_id=re.cycle_id
 JOIN customer_accounts rca ON rca.tenant_id=rp.tenant_id AND rca.customer_id=rp.customer_id AND rca.verified_at BETWEEN '1000-01-01' AND UTC_TIMESTAMP(6)
 WHERE re.id=e.entity_id AND re.tenant_id=e.tenant_id AND rp.store_id=e.store_id AND rp.customer_id=n.recipient_id
 AND rp.enabled=1 AND rp.expires_at>UTC_TIMESTAMP(6)
 AND ((rp.kind='CART' AND EXISTS(SELECT 1 FROM storefront_carts rc WHERE rc.tenant_id=rp.tenant_id AND rc.store_id=rp.store_id
  AND rc.customer_id=rp.customer_id AND rc.owner_hash=re.source_owner_hash AND rc.revision=re.source_revision AND JSON_LENGTH(rc.items_json)>0
  AND NOT EXISTS(SELECT 1 FROM customer_orders ro WHERE ro.tenant_id=rc.tenant_id AND ro.store_id=rc.store_id AND ro.customer_id=rc.customer_id AND ro.status NOT IN ('DRAFT','CANCELLED') AND ro.placed_at>=rc.updated_at)))
 OR (rp.kind='WISHLIST' AND EXISTS(SELECT 1 FROM storefront_wishlists rw WHERE rw.tenant_id=rp.tenant_id AND rw.store_id=rp.store_id
  AND rw.customer_id=rp.customer_id AND rw.owner_hash=re.source_owner_hash AND rw.revision=re.source_revision AND rw.consumed_at IS NULL AND JSON_LENGTH(rw.product_ids_json)>0
  AND NOT EXISTS(SELECT 1 FROM customer_orders ro WHERE ro.tenant_id=rw.tenant_id AND ro.store_id=rw.store_id AND ro.customer_id=rw.customer_id AND ro.status NOT IN ('DRAFT','CANCELLED') AND ro.placed_at>=rw.updated_at)))))`;
