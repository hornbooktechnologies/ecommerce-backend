import {getPrimaryPool} from '../../database/pool-factory.js';
import {uuidToBuffer as id,bufferToUuid as uuid} from '../../core/identifiers/uuid.js';
const map=row=>row?{id:uuid(row.id),brandId:uuid(row.brand_id),categoryId:uuid(row.category_id),brandName:row.brand_name||null,categoryName:row.category_name||null,guideId:uuid(row.guide_id),guideName:row.guide_name,guideStatus:row.guide_status,status:row.status,version:Number(row.version)}:null;
const joins=`FROM size_guide_defaults d JOIN size_guides g ON g.id=d.guide_id AND g.tenant_id=d.tenant_id
 LEFT JOIN brands b ON b.id=d.brand_id AND b.tenant_id=d.tenant_id
 LEFT JOIN categories c ON c.id=d.category_id AND c.tenant_id=d.tenant_id`;
const columns='d.*,b.name brand_name,c.name category_name,g.name guide_name,g.status guide_status';
export async function list({tenantId,filters,connection=getPrimaryPool()}){
 const where=['d.tenant_id=?'],params=[id(tenantId)];if(filters.status!=='ALL'){where.push('d.status=?');params.push(filters.status);}if(filters.search){where.push('(b.name LIKE ? OR c.name LIKE ? OR g.name LIKE ?)');params.push(...Array(3).fill(`%${filters.search}%`));}
 const [[count]]=await connection.execute(`SELECT COUNT(*) total ${joins} WHERE ${where.join(' AND ')}`,params);
 const [rows]=await connection.query(`SELECT ${columns} ${joins} WHERE ${where.join(' AND ')} ORDER BY d.updated_at DESC,d.id DESC LIMIT ? OFFSET ?`,[...params,filters.pageSize,(filters.page-1)*filters.pageSize]);
 return {items:rows.map(map),page:filters.page,pageSize:filters.pageSize,total:Number(count.total),totalPages:Math.max(1,Math.ceil(Number(count.total)/filters.pageSize))};
}
export async function find({tenantId,ruleId,connection,lock=false}){const [[row]]=await connection.execute(`SELECT ${columns} ${joins} WHERE d.tenant_id=? AND d.id=?${lock?' FOR UPDATE':''}`,[id(tenantId),id(ruleId)]);return map(row);}
export async function references({tenantId,input,connection}){
 for(const [table,value]of [['brands',input.brandId],['categories',input.categoryId]]){if(!value)continue;const [[row]]=await connection.execute(`SELECT id,status,deleted_at FROM ${table} WHERE tenant_id=? AND id=? FOR UPDATE`,[id(tenantId),id(value)]);if(!row||(input.status==='ACTIVE'&&(row.status!=='ACTIVE'||row.deleted_at)))return false;}return true;
}
export async function save({tenantId,ruleId,input,actorUserId,connection,create}){
 const values=[input.brandId?id(input.brandId):null,input.categoryId?id(input.categoryId):null,`${input.brandId||'*'}:${input.categoryId||'*'}`,id(input.guideId),input.status,id(actorUserId)];
 if(create)await connection.execute('INSERT INTO size_guide_defaults(brand_id,category_id,scope_key,guide_id,status,updated_by,tenant_id,id) VALUES(?,?,?,?,?,?,?,?)',[...values,id(tenantId),id(ruleId)]);
 else await connection.execute('UPDATE size_guide_defaults SET brand_id=?,category_id=?,scope_key=?,guide_id=?,status=?,updated_by=?,version=version+1 WHERE tenant_id=? AND id=?',[...values,id(tenantId),id(ruleId)]);
}
export async function excluded({tenantId,productId,connection=getPrimaryPool()}){const [[row]]=await connection.execute('SELECT product_id FROM product_size_guide_exclusions WHERE tenant_id=? AND product_id=?',[id(tenantId),id(productId)]);return Boolean(row);}
export async function setExcluded({tenantId,productId,excluded:hide,connection}){if(hide)await connection.execute('INSERT IGNORE INTO product_size_guide_exclusions(tenant_id,product_id) VALUES(?,?)',[id(tenantId),id(productId)]);else await connection.execute('DELETE FROM product_size_guide_exclusions WHERE tenant_id=? AND product_id=?',[id(tenantId),id(productId)]);}
export async function resolve({tenantId,productId,connection=getPrimaryPool(),publicOnly=false}){
 const [[product]]=await connection.execute(`SELECT p.brand_id,b.status brand_status,p.publication_status,p.approval_status,pg.guide_id,
 EXISTS(SELECT 1 FROM product_size_guide_exclusions ex WHERE ex.product_id=p.id AND ex.tenant_id=p.tenant_id) excluded
 FROM products p JOIN product_types pt ON pt.id=p.product_type_id AND pt.tenant_id=p.tenant_id AND pt.vertical='CLOTHING'
 JOIN tenant_product_verticals tv ON tv.tenant_id=p.tenant_id AND tv.vertical='CLOTHING' AND tv.status='ACTIVE'
 LEFT JOIN brands b ON b.id=p.brand_id AND b.tenant_id=p.tenant_id AND b.deleted_at IS NULL
 LEFT JOIN product_size_guides pg ON pg.product_id=p.id AND pg.tenant_id=p.tenant_id
 WHERE p.tenant_id=? AND p.id=? AND p.deleted_at IS NULL`,[id(tenantId),id(productId)]);
 const none={guideId:null,source:'NONE',ruleId:null};if(!product||(publicOnly&&(product.publication_status!=='PUBLISHED'||product.approval_status!=='APPROVED')))return none;
 if(product.excluded)return {...none,reason:'Disabled for this product'};
 if(product.guide_id)return {guideId:uuid(product.guide_id),source:'PRODUCT',ruleId:null};
 const [categories]=await connection.execute("SELECT c.id FROM product_categories pc JOIN categories c ON c.id=pc.category_id AND c.tenant_id=? AND c.status='ACTIVE' AND c.deleted_at IS NULL WHERE pc.product_id=? AND pc.is_primary=1 ORDER BY c.id",[id(tenantId),id(productId)]);
 const categoryId=categories.length===1?categories[0].id:null,brandId=product.brand_status==='ACTIVE'?product.brand_id:null;
 const [[rule]]=await connection.execute(`SELECT d.id,d.brand_id,d.category_id,d.guide_id FROM size_guide_defaults d WHERE d.tenant_id=? AND d.status='ACTIVE'
 AND (d.brand_id IS NULL OR d.brand_id=?) AND (d.category_id IS NULL OR d.category_id=?)
 ORDER BY (d.brand_id IS NOT NULL AND d.category_id IS NOT NULL) DESC,(d.brand_id IS NOT NULL) DESC,d.id LIMIT 1`,[id(tenantId),brandId,categoryId]);
 if(!rule)return {...none,reason:categories.length>1?'Multiple primary categories; category defaults were not matched.':'No matching default rule'};
 return {guideId:uuid(rule.guide_id),ruleId:uuid(rule.id),source:rule.brand_id?(rule.category_id?'BRAND_CATEGORY':'BRAND'):'CATEGORY'};
}
