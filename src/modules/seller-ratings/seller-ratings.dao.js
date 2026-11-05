import {getPrimaryPool} from '../../database/pool-factory.js';
import {uuidToBuffer as id,bufferToUuid as uuid} from '../../core/identifiers/uuid.js';

// Every non-cancelled line must have its full requested quantity in completed
// fulfilments. An order status alone, or one delivered line, is not evidence.
const delivered=`o.status NOT IN ('DRAFT','CANCELLED') AND so.status <> 'CANCELLED'
 AND EXISTS(SELECT 1 FROM order_items i WHERE i.tenant_id=so.tenant_id AND i.seller_order_id=so.id AND i.status<>'CANCELLED')
 AND NOT EXISTS(SELECT 1 FROM order_items i WHERE i.tenant_id=so.tenant_id AND i.seller_order_id=so.id AND i.status<>'CANCELLED'
   AND COALESCE((SELECT SUM(fi.requested_quantity) FROM fulfillment_items fi
     JOIN fulfillments f ON f.id=fi.fulfillment_id AND f.tenant_id=so.tenant_id AND f.seller_order_id=so.id
     WHERE fi.order_item_id=i.id AND f.status='COMPLETED'),0)<i.quantity)`;
const orderJoin=`FROM seller_orders so JOIN customer_orders o ON o.id=so.customer_order_id AND o.tenant_id=so.tenant_id
 JOIN merchants m ON m.id=so.merchant_id AND m.tenant_id=so.tenant_id AND m.merchant_type='VENDOR'`;
const iso=value=>value?new Date(value).toISOString():null;
const ownDto=row=>({sellerOrderId:uuid(row.id),sellerOrderNumber:row.seller_order_number,sellerName:row.display_name,
 eligible:Boolean(row.eligible),review:row.review_id?{id:uuid(row.review_id),rating:Number(row.rating),review:row.review_text,status:row.review_status}:null});

export async function ownOrders({tenantId,storeId,customerId,orderId,connection}){
 const [rows]=await connection.execute(`SELECT so.id,so.seller_order_number,m.display_name,(${delivered}) eligible,
 r.id review_id,r.rating,r.review_text,r.status review_status ${orderJoin}
 LEFT JOIN seller_ratings r ON r.seller_order_id=so.id AND r.tenant_id=so.tenant_id AND r.customer_id=o.customer_id
 WHERE o.tenant_id=? AND o.store_id=? AND o.customer_id=? AND o.id=? ORDER BY so.id`,[id(tenantId),id(storeId),id(customerId),id(orderId)]);
 return rows.map(ownDto);
}
export async function purchase({tenantId,storeId,customerId,orderId,sellerOrderId,connection}){
 const [[row]]=await connection.execute(`SELECT so.id,so.merchant_id,(${delivered}) eligible ${orderJoin}
 WHERE o.tenant_id=? AND o.store_id=? AND o.customer_id=? AND o.id=? AND so.id=? FOR UPDATE`,[id(tenantId),id(storeId),id(customerId),id(orderId),id(sellerOrderId)]);
 return row?{merchantId:uuid(row.merchant_id),eligible:Boolean(row.eligible)}:null;
}
export async function existing({tenantId,sellerOrderId,customerId,connection}){
 const [[row]]=await connection.execute('SELECT id,rating,review_text,status FROM seller_ratings WHERE tenant_id=? AND seller_order_id=? AND customer_id=? FOR UPDATE',[id(tenantId),id(sellerOrderId),id(customerId)]);
 return row?{id:uuid(row.id),rating:Number(row.rating),review:row.review_text,status:row.status}:null;
}
export async function insert({tenantId,storeId,customerId,orderId,sellerOrderId,merchantId,ratingId,firstName,input,connection}){
 await connection.execute(`INSERT INTO seller_ratings(id,tenant_id,store_id,merchant_id,customer_id,customer_order_id,seller_order_id,rating,review_text,customer_first_name)
 VALUES(?,?,?,?,?,?,?,?,?,?)`,[id(ratingId),id(tenantId),id(storeId),id(merchantId),id(customerId),id(orderId),id(sellerOrderId),input.rating,input.review,firstName]);
}
const adminJoin=`FROM seller_ratings r JOIN merchants m ON m.id=r.merchant_id AND m.tenant_id=r.tenant_id
 JOIN stores s ON s.id=r.store_id AND s.tenant_id=r.tenant_id
 JOIN customer_orders o ON o.id=r.customer_order_id AND o.tenant_id=r.tenant_id
 JOIN seller_orders so ON so.id=r.seller_order_id AND so.tenant_id=r.tenant_id`;
const adminColumns=`r.*,m.display_name seller_name,s.name store_name,o.order_number,so.seller_order_number`;
const adminDto=row=>({id:uuid(row.id),sellerName:row.seller_name,storeName:row.store_name,orderNumber:row.order_number,sellerOrderNumber:row.seller_order_number,
 customerName:row.customer_first_name,rating:Number(row.rating),review:row.review_text,status:row.status,moderationNote:row.moderation_note||'',version:Number(row.version),createdAt:iso(row.created_at)});
export async function list({tenantId,filters,connection=getPrimaryPool()}){
 let where='r.tenant_id=?',values=[id(tenantId)];if(filters.status!=='ALL'){where+=' AND r.status=?';values.push(filters.status);}
 if(filters.search){where+=' AND (m.display_name LIKE ? OR so.seller_order_number LIKE ? OR o.order_number LIKE ?)';values.push(...Array(3).fill(`%${filters.search}%`));}
 const [[count]]=await connection.execute(`SELECT COUNT(*) total ${adminJoin} WHERE ${where}`,values);
 const [rows]=await connection.query(`SELECT ${adminColumns} ${adminJoin} WHERE ${where} ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?`,[...values,filters.pageSize,(filters.page-1)*filters.pageSize]);
 return {...filters,items:rows.map(adminDto),total:Number(count.total),totalPages:Math.max(1,Math.ceil(Number(count.total)/filters.pageSize))};
}
export async function find({tenantId,ratingId,connection,lock=false}){const [[row]]=await connection.execute(`SELECT ${adminColumns} ${adminJoin} WHERE r.tenant_id=? AND r.id=?${lock?' FOR UPDATE':''}`,[id(tenantId),id(ratingId)]);return row?adminDto(row):null;}
export async function moderate({tenantId,ratingId,input,actorUserId,connection}){
 await connection.execute(`UPDATE seller_ratings SET status=?,moderation_note=?,moderated_by=?,moderated_at=UTC_TIMESTAMP(6),version=version+1 WHERE tenant_id=? AND id=? AND version=?`,[input.status,input.note||null,id(actorUserId),id(tenantId),id(ratingId),input.version]);
}
const publicJoin=`FROM seller_ratings r JOIN seller_orders so ON so.id=r.seller_order_id AND so.tenant_id=r.tenant_id AND so.merchant_id=r.merchant_id AND so.customer_order_id=r.customer_order_id
 JOIN customer_orders o ON o.id=r.customer_order_id AND o.tenant_id=r.tenant_id AND o.store_id=r.store_id AND o.customer_id=r.customer_id
 JOIN merchants m ON m.id=r.merchant_id AND m.tenant_id=r.tenant_id AND m.status='ACTIVE' AND m.merchant_type='VENDOR'
 JOIN vendor_profiles vp ON vp.merchant_id=m.id AND vp.tenant_id=m.tenant_id AND vp.onboarding_status='APPROVED'
 JOIN store_merchants sm ON sm.store_id=r.store_id AND sm.merchant_id=m.id AND sm.status='ACTIVE'`;
const publicWhere=`r.tenant_id=? AND r.store_id=? AND r.status='PUBLISHED' AND (${delivered})`;
export async function summaries({tenantId,storeId,merchantIds,connection=getPrimaryPool()}){
 if(!merchantIds.length)return new Map();
 const [rows]=await connection.query(`SELECT r.merchant_id,COUNT(*) total,ROUND(AVG(r.rating),1) average ${publicJoin} WHERE ${publicWhere} AND r.merchant_id IN (?) GROUP BY r.merchant_id`,[id(tenantId),id(storeId),merchantIds.map(id)]);
 return new Map(rows.map(row=>[uuid(row.merchant_id),{count:Number(row.total),average:Number(row.average)}]));
}
export async function publicList({tenantId,storeId,merchantId,page=1,pageSize=10,connection=getPrimaryPool()}){
 const summary=(await summaries({tenantId,storeId,merchantIds:[merchantId],connection})).get(merchantId)||{count:0,average:null};
 const [rows]=await connection.query(`SELECT r.id,r.rating,r.review_text,r.customer_first_name,r.created_at ${publicJoin} WHERE ${publicWhere} AND r.merchant_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?`,[id(tenantId),id(storeId),id(merchantId),pageSize,(page-1)*pageSize]);
 return {summary,items:rows.map(row=>({id:uuid(row.id),rating:Number(row.rating),review:row.review_text,customerName:row.customer_first_name,createdAt:iso(row.created_at)})),page,pageSize,total:summary.count,totalPages:Math.max(1,Math.ceil(summary.count/pageSize))};
}
