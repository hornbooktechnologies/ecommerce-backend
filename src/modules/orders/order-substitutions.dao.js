import {uuidToBuffer as id, bufferToUuid as uuid} from '../../core/identifiers/uuid.js';
import * as inbox from '../notifications/inbox.dao.js';
const json = value => typeof value === 'string' ? JSON.parse(value) : value;

export async function context({tenantId,orderId,itemId,connection}) {
  const [[r]]=await connection.execute(`SELECT oi.*, co.store_id, co.customer_id,
    co.status order_status, co.payment_method, co.payment_status, co.fulfillment_status,
    co.currency, co.prices_include_tax, co.version order_version, co.shipping_address_snapshot, co.grand_total,
    EXISTS(SELECT 1 FROM stores s WHERE s.tenant_id=co.tenant_id AND s.id=co.store_id AND s.status='ACTIVE' AND s.deleted_at IS NULL) active_store,
    so.merchant_id, pv.selling_uom_id, pv.sold_by_weight, pt.vertical, p.product_kind,
    JSON_UNQUOTE(JSON_EXTRACT(p.metadata,'$.grocery.allowSubstitutions')) IN ('true','1') allows_substitutions,
    EXISTS(SELECT 1 FROM promotion_redemptions pr WHERE pr.tenant_id=co.tenant_id
      AND pr.customer_order_id=co.id AND pr.reversed_at IS NULL) has_promotion,
    EXISTS(SELECT 1 FROM tax_documents td WHERE td.tenant_id=co.tenant_id
      AND td.customer_order_id=co.id AND td.status='ISSUED') has_invoice,
    EXISTS(SELECT 1 FROM fulfillments f JOIN seller_orders fs ON fs.id=f.seller_order_id
      WHERE f.tenant_id=co.tenant_id AND fs.customer_order_id=co.id) has_fulfillment,
    EXISTS(SELECT 1 FROM return_requests rr WHERE rr.tenant_id=co.tenant_id AND rr.customer_order_id=co.id) has_return,
    EXISTS(SELECT 1 FROM order_item_substitutions os WHERE os.tenant_id=oi.tenant_id AND os.order_item_id=oi.id) already_substituted
    FROM customer_orders co JOIN seller_orders so ON so.customer_order_id=co.id AND so.tenant_id=co.tenant_id
    JOIN order_items oi ON oi.seller_order_id=so.id AND oi.tenant_id=co.tenant_id
    LEFT JOIN product_variants pv ON pv.id=oi.variant_id AND pv.tenant_id=oi.tenant_id
    LEFT JOIN products p ON p.id=pv.product_id AND p.tenant_id=oi.tenant_id
    LEFT JOIN product_types pt ON pt.id=p.product_type_id AND pt.tenant_id=oi.tenant_id
    WHERE co.tenant_id=? AND co.id=? AND oi.id=? FOR UPDATE`,[id(tenantId),id(orderId),id(itemId)]);
  if(!r)return null;
  const [payments]=await connection.execute(`SELECT payment_method,status,currency,authorized_amount,captured_amount,refunded_amount
    FROM payments WHERE tenant_id=? AND customer_order_id=? FOR UPDATE`,[id(tenantId),id(orderId)]);
  return {...r,id:uuid(r.id),offerId:uuid(r.offer_id),variantId:uuid(r.variant_id),
    sellerOrderId:uuid(r.seller_order_id),storeId:uuid(r.store_id),merchantId:uuid(r.merchant_id),
    sellingUomId:uuid(r.selling_uom_id),product:json(r.product_snapshot)||{},
    address:json(r.shipping_address_snapshot)||{},orderVersion:Number(r.order_version),
    has_payment:payments.length>1||payments.some(p=>p.payment_method!=='COD'||p.status!=='PENDING'||p.currency!=='INR'
      ||Number(p.authorized_amount)>0||Number(p.captured_amount)>0||Number(p.refunded_amount)>0)};
}

export async function warehouses({tenantId,storeId,merchantId,connection}) {
  const [rows]=await connection.execute(`SELECT id,name FROM warehouses WHERE tenant_id=? AND merchant_id=?
    AND (store_id=? OR store_id IS NULL) AND status='ACTIVE' AND deleted_at IS NULL ORDER BY name,id`,
  [id(tenantId),id(merchantId),id(storeId)]);
  return rows.map(r=>({id:uuid(r.id),name:r.name}));
}

export async function candidates({tenantId,storeId,merchantId,variantId,connection}) {
  const [rows]=await connection.execute(`SELECT ps.id rule_id,ps.priority,ps.maximum_price_difference_percent,
    so.id offer_id,pv.id variant_id,pv.selling_uom_id,pv.sold_by_weight,pt.lot_tracking_enabled,
    pt.serial_tracking_enabled,pt.expiry_tracking_enabled,p.name product_name,pv.name variant_name,pv.sku
    FROM product_substitutes ps
    JOIN product_variants pv ON pv.id=ps.substitute_variant_id AND pv.tenant_id=ps.tenant_id
      AND pv.status='ACTIVE' AND pv.deleted_at IS NULL
    JOIN products p ON p.id=pv.product_id AND p.tenant_id=ps.tenant_id AND p.deleted_at IS NULL
      AND p.approval_status='APPROVED' AND p.publication_status='PUBLISHED' AND p.product_kind='STANDARD'
    JOIN product_types pt ON pt.id=p.product_type_id AND pt.tenant_id=ps.tenant_id
      AND pt.vertical='GROCERY' AND pt.deleted_at IS NULL
    JOIN tenant_product_verticals tv ON tv.tenant_id=ps.tenant_id AND tv.vertical='GROCERY' AND tv.status='ACTIVE'
    JOIN seller_offers so ON so.variant_id=pv.id AND so.tenant_id=ps.tenant_id
      AND so.store_id=? AND so.merchant_id=? AND so.status='ACTIVE' AND so.deleted_at IS NULL
    JOIN merchants m ON m.id=so.merchant_id AND m.tenant_id=ps.tenant_id AND m.status='ACTIVE' AND m.deleted_at IS NULL
      AND (m.merchant_type='FIRST_PARTY' OR EXISTS(SELECT 1 FROM vendor_profiles vp
        WHERE vp.tenant_id=m.tenant_id AND vp.merchant_id=m.id AND vp.onboarding_status='APPROVED'))
    JOIN store_merchants sm ON sm.store_id=so.store_id AND sm.merchant_id=m.id AND sm.status='ACTIVE'
    WHERE ps.tenant_id=? AND ps.source_variant_id=? AND ps.status='ACTIVE'
      AND EXISTS(SELECT 1 FROM offer_prices op JOIN price_lists pl ON pl.id=op.price_list_id AND pl.tenant_id=op.tenant_id
        WHERE op.tenant_id=ps.tenant_id AND op.offer_id=so.id AND pl.status='ACTIVE' AND pl.currency='INR' AND pl.includes_tax=1
          AND (pl.store_id IS NULL OR pl.store_id=so.store_id)
          AND (pl.starts_at IS NULL OR pl.starts_at<=UTC_TIMESTAMP()) AND (pl.ends_at IS NULL OR pl.ends_at>UTC_TIMESTAMP())
          AND (op.starts_at IS NULL OR op.starts_at<=UTC_TIMESTAMP()) AND (op.ends_at IS NULL OR op.ends_at>UTC_TIMESTAMP()))
    ORDER BY ps.priority,ps.id,so.id FOR UPDATE`,[id(storeId),id(merchantId),id(tenantId),id(variantId)]);
  return rows.map(r=>({...r,ruleId:uuid(r.rule_id),offerId:uuid(r.offer_id),variantId:uuid(r.variant_id),
    sellingUomId:uuid(r.selling_uom_id),priority:Number(r.priority),
    maximumPriceDifferencePercent:r.maximum_price_difference_percent===null?null:Number(r.maximum_price_difference_percent)}));
}

export async function stock({tenantId,warehouseId,offerId,connection}) {
  const [[r]]=await connection.execute(`SELECT ib.id,ib.on_hand_quantity,ib.reserved_quantity,ib.quarantine_quantity,ib.safety_stock_quantity,
    pt.lot_tracking_enabled,pt.expiry_tracking_enabled FROM inventory_balances ib
    JOIN seller_offers so ON so.id=ib.offer_id AND so.tenant_id=ib.tenant_id
    JOIN product_variants pv ON pv.id=so.variant_id AND pv.tenant_id=ib.tenant_id
    JOIN products p ON p.id=pv.product_id AND p.tenant_id=ib.tenant_id
    JOIN product_types pt ON pt.id=p.product_type_id AND pt.tenant_id=ib.tenant_id
    WHERE ib.tenant_id=? AND ib.warehouse_id=? AND ib.offer_id=? FOR UPDATE`,[id(tenantId),id(warehouseId),id(offerId)]);
  if(!r)return {balance:null,lots:[]};
  const [lots]=r.lot_tracking_enabled ? await connection.execute(`SELECT on_hand_quantity,reserved_quantity,quarantine_quantity
    FROM inventory_lots WHERE tenant_id=? AND inventory_balance_id=? AND status='ACTIVE'
    AND (expires_at IS NULL OR expires_at>=UTC_DATE())
    AND (?=0 OR expires_at IS NOT NULL) ORDER BY expires_at,id FOR UPDATE`,[id(tenantId),r.id,r.expiry_tracking_enabled]) : [[]];
  return {balance:r,lots};
}

export async function receipt({tenantId,requestKey,connection}) {
  const [[r]]=await connection.execute(`SELECT order_id,request_hash FROM order_item_substitutions
    WHERE tenant_id=? AND request_key=?`,[id(tenantId),id(requestKey)]);
  return r?{orderId:uuid(r.order_id),hash:r.request_hash.toString('hex')}:null;
}

export async function updateLine({tenantId,itemId,line,connection}) {
  await connection.execute(`UPDATE order_items SET offer_id=?,variant_id=?,product_name=?,variant_name=?,sku=?,
    hsn_sac_code=?,unit_price=?,list_price=?,discount_total=?,taxable_amount=?,cgst_rate=?,cgst_amount=?,
    sgst_rate=?,sgst_amount=?,igst_rate=?,igst_amount=?,cess_rate=?,cess_amount=?,tax_total=?,line_total=?,product_snapshot=?
    WHERE tenant_id=? AND id=?`,[id(line.offerId),id(line.variantId),line.productName,line.variantName,line.sku,
    line.hsnSacCode,line.unitPrice,line.listPrice,line.discountTotal,line.taxableAmount,line.cgstRate,line.cgstAmount,
    line.sgstRate,line.sgstAmount,line.igstRate,line.igstAmount,line.cessRate,line.cessAmount,line.taxTotal,line.lineTotal,
    JSON.stringify(line.productSnapshot),id(tenantId),id(itemId)]);
}

export async function updateTotals({tenantId,orderId,sellerOrderId,delta,connection}) {
  const args=[delta.subtotal,delta.discount,delta.tax,delta.total];
  await connection.execute(`UPDATE seller_orders SET subtotal=subtotal+?,discount_total=discount_total+?,
    tax_total=tax_total+?,grand_total=grand_total+?,merchant_payable_total=merchant_payable_total+?,version=version+1
    WHERE tenant_id=? AND id=?`,[...args,delta.total,id(tenantId),id(sellerOrderId)]);
  await connection.execute(`UPDATE customer_orders SET subtotal=subtotal+?,discount_total=discount_total+?,
    tax_total=tax_total+?,grand_total=grand_total+?,version=version+1 WHERE tenant_id=? AND id=?`,[...args,id(tenantId),id(orderId)]);
  await connection.execute(`UPDATE payments pay JOIN customer_orders co ON co.id=pay.customer_order_id AND co.tenant_id=pay.tenant_id
    SET pay.requested_amount=co.grand_total WHERE pay.tenant_id=? AND pay.customer_order_id=?
      AND pay.payment_method='COD' AND pay.status='PENDING'`,[id(tenantId),id(orderId)]);
}

export async function insertReceipt({record,connection}) {
  await connection.execute(`INSERT INTO order_item_substitutions (id,tenant_id,order_id,order_item_id,rule_id,
    warehouse_id,request_key,request_hash,original_snapshot,replacement_snapshot,consent_basis,approval_reference,reason,recorded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id(record.id),id(record.tenantId),id(record.orderId),id(record.itemId),id(record.ruleId),
    id(record.warehouseId),id(record.requestKey),Buffer.from(record.hash,'hex'),JSON.stringify(record.original),
    JSON.stringify(record.replacement),record.consentBasis,record.approvalReference||null,record.reason,id(record.actorUserId)]);
}

export async function notify({tenantId,orderId,key,connection}) {
  const source=await inbox.sourceOrder({tenantId,orderId,connection});
  if(!source?.customerId)return;
  await inbox.enqueue({event:{tenantId,storeId:source.storeId,kind:'ORDER_SUBSTITUTED',category:'ORDERS',
    entityType:'ORDER',entityId:orderId,orderId,key:`order-substituted:${key}`,audience:'CUSTOMER',
    recipients:[source.customerId],title:'An order item was replaced',
    message:'Your store recorded an approved grocery replacement. View your order for the original item, replacement and updated total. Your bill has not increased.'},connection});
}
