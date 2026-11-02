import {getPrimaryPool} from '../../database/pool-factory.js';
import {uuidToBuffer as id,bufferToUuid as uuid} from '../../core/identifiers/uuid.js';
import {createId} from '../../core/identifiers/uuid.js';
import {deliveredItemSql} from '../customer-accounts/customer-reviews.dao.js';
const map=row=>({id:uuid(row.id),reviewId:uuid(row.review_id),storageKey:row.storage_key,hash:row.source_hash,alt:row.alt_text,status:row.status,storageState:row.storage_state,width:row.width,height:row.height,byteSize:row.byte_size,version:Number(row.version),deletedAt:row.deleted_at,moderationNote:row.moderation_note});
export async function lockReview({tenantId,reviewId,connection}){const [[row]]=await connection.execute('SELECT id,status,deleted_at FROM product_ratings WHERE tenant_id=? AND id=? FOR UPDATE',[id(tenantId),id(reviewId)]);return row;}
export async function ownedReview({tenantId,storeId,customerId,reviewId,connection}){
 const [[row]]=await connection.execute(`SELECT pr.id,pr.status,pr.deleted_at,pr.source,pr.verified_purchase,
  (o.status NOT IN ('DRAFT','CANCELLED') AND i.status<>'CANCELLED' AND p.deleted_at IS NULL AND ${deliveredItemSql}) eligible
  FROM product_ratings pr JOIN customer_orders o ON o.id=pr.customer_order_id AND o.tenant_id=pr.tenant_id AND o.customer_id=pr.customer_id
  JOIN order_items i ON i.id=pr.order_item_id AND i.tenant_id=pr.tenant_id AND i.customer_order_id=o.id
  JOIN products p ON p.id=pr.product_id AND p.tenant_id=pr.tenant_id
  WHERE pr.tenant_id=? AND pr.id=? AND pr.customer_id=? AND o.store_id=?`,[id(tenantId),id(reviewId),id(customerId),id(storeId)]);
 return row?{status:row.status,deletedAt:row.deleted_at,eligible:Boolean(row.eligible)&&row.source==='STOREFRONT'&&Boolean(row.verified_purchase)}:null;
}
export async function find({tenantId,reviewId,photoId,connection=getPrimaryPool(),lock=false}){const [[row]]=await connection.execute(`SELECT * FROM review_photos WHERE tenant_id=? AND review_id=? AND id=? ${lock?'FOR UPDATE':''}`,[id(tenantId),id(reviewId),id(photoId)]);return row?map(row):null;}
export async function list({tenantId,reviewId,connection=getPrimaryPool()}){const [rows]=await connection.execute('SELECT * FROM review_photos WHERE tenant_id=? AND review_id=? AND deleted_at IS NULL ORDER BY created_at,id',[id(tenantId),id(reviewId)]);return rows.map(map);}
export async function dailyAttempts({tenantId,customerId,connection}){const [[row]]=await connection.execute('SELECT COUNT(*) n FROM review_photos ph JOIN product_ratings pr ON pr.id=ph.review_id AND pr.tenant_id=ph.tenant_id WHERE ph.tenant_id=? AND pr.customer_id=? AND ph.created_at>=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 DAY)',[id(tenantId),id(customerId)]);return Number(row.n);}
export async function insert({tenantId,reviewId,photoId,key,hash,alt,connection}){await connection.execute('INSERT INTO review_photos(id,tenant_id,review_id,storage_key,source_hash,alt_text) VALUES(?,?,?,?,?,?)',[id(photoId),id(tenantId),id(reviewId),key,hash,alt]);}
export async function ready({tenantId,reviewId,photoId,image,connection}){await connection.execute("UPDATE review_photos SET storage_state='READY',width=?,height=?,byte_size=?,version=version+1 WHERE tenant_id=? AND review_id=? AND id=? AND deleted_at IS NULL",[image.width,image.height,image.byteSize,id(tenantId),id(reviewId),id(photoId)]);}
export async function markRemoved({tenantId,reviewId,photoId,connection}){await connection.execute("UPDATE review_photos SET status='REMOVED',deleted_at=COALESCE(deleted_at,UTC_TIMESTAMP(6)),version=version+1 WHERE tenant_id=? AND review_id=? AND id=? AND deleted_at IS NULL",[id(tenantId),id(reviewId),id(photoId)]);}
export async function abortStage({tenantId,photoId,key,connection=getPrimaryPool()}){await connection.execute("UPDATE review_photos SET status='REMOVED',deleted_at=COALESCE(deleted_at,UTC_TIMESTAMP(6)),version=version+1 WHERE tenant_id=? AND id=? AND storage_key=? AND storage_state='STAGED' AND deleted_at IS NULL",[id(tenantId),id(photoId),key]);}
export async function fileRemoved({tenantId,photoId,connection=getPrimaryPool()}){await connection.execute('UPDATE review_photos SET file_removed_at=UTC_TIMESTAMP(6) WHERE tenant_id=? AND id=? AND deleted_at IS NOT NULL',[id(tenantId),id(photoId)]);}
export async function moderate({tenantId,reviewId,photoId,status,note,actorUserId,connection}){await connection.execute('UPDATE review_photos SET status=?,moderation_note=?,moderated_by=?,version=version+1 WHERE tenant_id=? AND review_id=? AND id=? AND deleted_at IS NULL',[status,note,id(actorUserId),id(tenantId),id(reviewId),id(photoId)]);}
export async function publicPhotos({scope,reviewIds,connection=getPrimaryPool()}){
 if(!reviewIds.length)return [];
 const [rows]=await connection.execute(`SELECT ph.* FROM review_photos ph JOIN product_ratings pr ON pr.id=ph.review_id AND pr.tenant_id=ph.tenant_id
 JOIN customer_orders o ON o.id=pr.customer_order_id AND o.tenant_id=pr.tenant_id AND o.customer_id=pr.customer_id
 JOIN order_items i ON i.id=pr.order_item_id AND i.customer_order_id=o.id AND i.tenant_id=pr.tenant_id
 WHERE ph.tenant_id=? AND o.store_id=? AND ph.review_id IN (${reviewIds.map(()=>'?').join(',')})
 AND ph.deleted_at IS NULL AND ph.storage_state='READY' AND ph.status='APPROVED' AND pr.status='PUBLISHED' AND pr.deleted_at IS NULL
 AND pr.source='STOREFRONT' AND pr.verified_purchase=1 AND o.status NOT IN ('DRAFT','CANCELLED') AND i.status<>'CANCELLED' AND ${deliveredItemSql}
 ORDER BY ph.created_at,ph.id`,[id(scope.tenantId),id(scope.storeId),...reviewIds.map(id)]);
 return rows.map(map);
}
export async function publicSource({tenantId,storeId,photoId,connection=getPrimaryPool()}){const [[row]]=await connection.execute(`SELECT ph.review_id,p.slug FROM review_photos ph JOIN product_ratings pr ON pr.id=ph.review_id AND pr.tenant_id=ph.tenant_id JOIN products p ON p.id=pr.product_id AND p.tenant_id=pr.tenant_id AND p.deleted_at IS NULL JOIN customer_orders o ON o.id=pr.customer_order_id AND o.tenant_id=pr.tenant_id WHERE ph.tenant_id=? AND ph.id=? AND o.store_id=?`,[id(tenantId),id(photoId),id(storeId)]);return row?{reviewId:uuid(row.review_id),slug:row.slug}:null;}
export async function audit({tenantId,reviewId,photoId,action,actorUserId,customerId,connection}){await connection.execute("INSERT INTO audit_logs(id,tenant_id,actor_type,actor_user_id,action,entity_type,entity_id,after_data) VALUES(?,?,?,?,?,'REVIEW_PHOTO',?,?)",[id(createId()),id(tenantId),actorUserId?'USER':'CUSTOMER',actorUserId?id(actorUserId):null,action,id(photoId),JSON.stringify({reviewId,...(customerId?{customerId}:{})})]);}
export async function cleanupCandidates({connection=getPrimaryPool()}={}){await connection.execute("UPDATE review_photos SET status='REMOVED',deleted_at=UTC_TIMESTAMP(6),version=version+1 WHERE storage_state='STAGED' AND deleted_at IS NULL AND created_at<DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 HOUR) LIMIT 100");const [rows]=await connection.execute('SELECT id,tenant_id,storage_key FROM review_photos WHERE deleted_at IS NOT NULL AND file_removed_at IS NULL ORDER BY deleted_at LIMIT 100');return rows.map(row=>({photoId:uuid(row.id),tenantId:uuid(row.tenant_id),storageKey:row.storage_key}));}
