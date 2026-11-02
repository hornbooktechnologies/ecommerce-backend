// Internal aliases/expressions only. The caller always binds a customer-supplied merchant ID.
export const vendorEligibility=(merchant='?')=>`EXISTS (
 SELECT 1 FROM seller_offers qo
 JOIN product_variants qv ON qv.id=qo.variant_id AND qv.tenant_id=qo.tenant_id AND qv.status='ACTIVE' AND qv.deleted_at IS NULL
 JOIN products qp ON qp.id=qv.product_id AND qp.tenant_id=qo.tenant_id AND qp.deleted_at IS NULL AND qp.publication_status='PUBLISHED' AND qp.approval_status='APPROVED'
 JOIN product_types qt ON qt.id=qp.product_type_id AND qt.tenant_id=qp.tenant_id AND qt.deleted_at IS NULL
 JOIN tenant_product_verticals tv ON tv.tenant_id=qp.tenant_id AND tv.vertical=qt.vertical AND tv.status='ACTIVE'
 JOIN merchants qm ON qm.id=qo.merchant_id AND qm.tenant_id=qo.tenant_id AND qm.merchant_type='VENDOR' AND qm.status='ACTIVE' AND qm.deleted_at IS NULL
 JOIN vendor_profiles qvp ON qvp.merchant_id=qm.id AND qvp.tenant_id=qm.tenant_id AND qvp.onboarding_status='APPROVED'
 JOIN store_merchants qsm ON qsm.store_id=qo.store_id AND qsm.merchant_id=qo.merchant_id AND qsm.status='ACTIVE'
 JOIN stores qs ON qs.id=qo.store_id AND qs.tenant_id=qo.tenant_id AND qs.status='ACTIVE' AND qs.deleted_at IS NULL
 WHERE qo.tenant_id=q.tenant_id AND qo.store_id=q.store_id AND qv.product_id=q.product_id AND qo.merchant_id=${merchant} AND qo.status='ACTIVE' AND qo.deleted_at IS NULL)`;
export const visibleAnswer=`a.status='PUBLISHED' AND (a.merchant_id IS NULL OR ${vendorEligibility('a.merchant_id')})`;
