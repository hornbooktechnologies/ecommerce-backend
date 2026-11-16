import {getPrimaryPool} from '../../database/pool-factory.js';
import {resolve as resolveDefault} from './size-guide-defaults.dao.js';
import {uuidToBuffer as id,bufferToUuid as uuid} from '../../core/identifiers/uuid.js';

const json = value => typeof value === 'string' ? JSON.parse(value) : value;
function map(row) {
 return row ? {id:uuid(row.id),name:row.name,unit:row.unit,basis:row.measurement_basis,description:row.description,
  instructions:row.instructions,columns:json(row.columns_json),rows:json(row.rows_json),status:row.status,version:Number(row.version),usageCount:Number(row.usage_count || 0)} : null;
}
export async function list({tenantId,filters,connection=getPrimaryPool()}) {
 const where=['g.tenant_id=?','g.deleted_at IS NULL'],params=[id(tenantId)];
 if(filters.status!=='ALL'){where.push('g.status=?');params.push(filters.status);}
 if(filters.search){where.push("g.name LIKE ? ESCAPE '\\\\'");params.push(`%${filters.search.replace(/[\\%_]/g,'\\$&')}%`);}
 const predicate=where.join(' AND ');
 const [[rows],[[count]]]=await Promise.all([
  connection.query(`SELECT g.id,g.name,g.unit,g.measurement_basis,g.status,g.version,
   (SELECT COUNT(*) FROM product_size_guides pg JOIN products p ON p.id=pg.product_id AND p.deleted_at IS NULL WHERE pg.tenant_id=g.tenant_id AND pg.guide_id=g.id) usage_count
   FROM size_guides g WHERE ${predicate} ORDER BY g.name,g.id LIMIT ? OFFSET ?`,[...params,filters.pageSize,(filters.page-1)*filters.pageSize]),
  connection.execute(`SELECT COUNT(*) total FROM size_guides g WHERE ${predicate}`,params)
 ]);
 return {items:rows.map(row=>({id:uuid(row.id),name:row.name,unit:row.unit,basis:row.measurement_basis,status:row.status,version:Number(row.version),usageCount:Number(row.usage_count)})),total:Number(count.total),page:filters.page,pageSize:filters.pageSize,totalPages:Math.max(1,Math.ceil(Number(count.total)/filters.pageSize))};
}
export async function find({tenantId,guideId,connection=getPrimaryPool(),lock=false}) {
 const [[row]]=await connection.execute(`SELECT * FROM size_guides WHERE tenant_id=? AND id=? AND deleted_at IS NULL ${lock?'FOR UPDATE':''}`,[id(tenantId),id(guideId)]);
 return map(row);
}
export async function save({tenantId,guideId,input,connection,create=false}) {
 const fields=[input.name,input.unit,input.basis,input.description,input.instructions,JSON.stringify(input.columns),JSON.stringify(input.rows),input.status];
 if(create) await connection.execute(`INSERT INTO size_guides (name,unit,measurement_basis,description,instructions,columns_json,rows_json,status,tenant_id,id) VALUES (?,?,?,?,?,?,?,?,?,?)`,[...fields,id(tenantId),id(guideId)]);
 else await connection.execute(`UPDATE size_guides SET name=?,unit=?,measurement_basis=?,description=?,instructions=?,columns_json=?,rows_json=?,status=?,version=version+1 WHERE tenant_id=? AND id=? AND deleted_at IS NULL`,[...fields,id(tenantId),id(guideId)]);
}
export async function product({tenantId,productId,connection=getPrimaryPool(),lock=false}) {
 const [[row]]=await connection.execute(`SELECT p.id,p.name,pt.vertical,p.publication_status FROM products p JOIN product_types pt ON pt.id=p.product_type_id AND pt.tenant_id=p.tenant_id
  JOIN tenant_product_verticals tpv ON tpv.tenant_id=p.tenant_id AND tpv.vertical=pt.vertical AND tpv.status='ACTIVE'
  WHERE p.tenant_id=? AND p.id=? AND p.deleted_at IS NULL ${lock?'FOR UPDATE':''}`,[id(tenantId),id(productId)]);
 return row ? {id:uuid(row.id),name:row.name,vertical:row.vertical,publicationStatus:row.publication_status} : null;
}
export async function binding({tenantId,productId,connection=getPrimaryPool()}) {
 const [[row]]=await connection.execute('SELECT guide_id FROM product_size_guides WHERE tenant_id=? AND product_id=?',[id(tenantId),id(productId)]);
 return row ? uuid(row.guide_id) : null;
}
export async function bind({tenantId,productId,guideId,connection}) {
 if(!guideId) await connection.execute('DELETE FROM product_size_guides WHERE tenant_id=? AND product_id=?',[id(tenantId),id(productId)]);
 else await connection.execute(`INSERT INTO product_size_guides (tenant_id,product_id,guide_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE guide_id=VALUES(guide_id),updated_at=UTC_TIMESTAMP(6)`,[id(tenantId),id(productId),id(guideId)]);
}
export async function publicGuide({tenantId,productId,connection=getPrimaryPool()}) {
 const resolved=await resolveDefault({tenantId,productId,connection,publicOnly:true});if(!resolved.guideId)return null;
 const guide=await find({tenantId,guideId:resolved.guideId,connection});if(!guide||guide.status!=='ACTIVE')return null;
 const safe={...guide};delete safe.status;delete safe.usageCount;return safe;
}
