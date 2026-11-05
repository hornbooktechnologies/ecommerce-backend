import {getPrimaryPool} from '../../database/pool-factory.js';
import {uuidToBuffer as id} from '../../core/identifiers/uuid.js';
const json=value=>typeof value==='string'?JSON.parse(value):value;
export async function context({tenantId,merchantId,storeId,connection=getPrimaryPool(),lock=false}){
 if(lock)await connection.execute("SELECT id FROM merchants WHERE tenant_id=? AND id=? AND merchant_type='VENDOR' AND deleted_at IS NULL FOR UPDATE",[id(tenantId),id(merchantId)]);
 const [[r]]=await connection.execute(`SELECT m.display_name,m.logo_url,m.status merchant_status,vp.onboarding_status,s.status store_status,s.deleted_at store_deleted,sm.status link_status FROM merchants m JOIN vendor_profiles vp ON vp.merchant_id=m.id AND vp.tenant_id=m.tenant_id JOIN stores s ON s.tenant_id=m.tenant_id AND s.id=? LEFT JOIN store_merchants sm ON sm.merchant_id=m.id AND sm.store_id=s.id WHERE m.tenant_id=? AND m.id=? AND m.merchant_type='VENDOR' AND m.deleted_at IS NULL`,[id(storeId),id(tenantId),id(merchantId)]);return r||null;
}
export async function find({tenantId,merchantId,storeId,connection=getPrimaryPool()}){const [[r]]=await connection.execute('SELECT * FROM seller_public_profiles WHERE tenant_id=? AND store_id=? AND merchant_id=?',[id(tenantId),id(storeId),id(merchantId)]);return r?{draft:json(r.draft_content),published:json(r.published_content),visible:Boolean(r.is_visible),version:Number(r.version),publishedAt:r.published_at instanceof Date?r.published_at.toISOString():r.published_at}:null;}
export async function save({tenantId,merchantId,storeId,input,actorUserId,connection}){
 const keys=[id(tenantId),id(storeId),id(merchantId)];
 if(input.action==='HIDE'){await connection.execute('UPDATE seller_public_profiles SET is_visible=0,version=version+1,updated_by=? WHERE tenant_id=? AND store_id=? AND merchant_id=?',[id(actorUserId),...keys]);return;}
 const body=JSON.stringify(input.content),publish=input.action==='PUBLISH';
 await connection.execute(`INSERT INTO seller_public_profiles(tenant_id,store_id,merchant_id,draft_content,published_content,is_visible,updated_by,published_at) VALUES(?,?,?,?,?,?,?,IF(?,UTC_TIMESTAMP(6),NULL)) ON DUPLICATE KEY UPDATE draft_content=VALUES(draft_content),published_content=IF(?,VALUES(published_content),published_content),is_visible=IF(?,1,is_visible),updated_by=VALUES(updated_by),published_at=IF(?,UTC_TIMESTAMP(6),published_at),version=version+1`,[...keys,body,publish?body:null,publish?1:0,id(actorUserId),publish,publish,publish,publish]);
}
