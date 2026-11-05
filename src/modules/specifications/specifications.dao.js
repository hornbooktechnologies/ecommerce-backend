import {getPrimaryPool} from '../../database/pool-factory.js';
import {uuidToBuffer as id,bufferToUuid as uuid} from '../../core/identifiers/uuid.js';
const json=value=>typeof value==='string'?JSON.parse(value):value;
const map=row=>({id:uuid(row.id),code:row.code,name:row.name,vertical:row.vertical,unit:row.unit,status:row.status,categoryId:uuid(row.category_id),categoryName:row.category_name||'',
 dataType:row.data_type,group:row.group_name,helpText:row.help_text,options:json(row.options_json),
 customerVisible:Boolean(row.customer_visible),filterable:Boolean(row.filterable),sortOrder:Number(row.sort_order),version:Number(row.version)});
export async function lockTenant({tenantId,connection}){await connection.execute('SELECT id FROM tenants WHERE id=? FOR UPDATE',[id(tenantId)]);}
export async function scopes({tenantId,vertical,categoryId,connection}){
 const [[type]]=await connection.execute("SELECT vertical FROM tenant_product_verticals WHERE tenant_id=? AND vertical=? AND status='ACTIVE'",[id(tenantId),vertical]);
 if(!type)return false;
 if(!categoryId)return true;
 const [[category]]=await connection.execute("SELECT id FROM categories WHERE tenant_id=? AND id=? AND status='ACTIVE' AND deleted_at IS NULL",[id(tenantId),id(categoryId)]);
 return Boolean(category);
}
export async function list({tenantId,filters,connection=getPrimaryPool()}){
 const where=['d.tenant_id=?'],params=[id(tenantId)];
 if(filters.status!=='ALL'){where.push('d.status=?');params.push(filters.status);}
 if(filters.vertical!=='ALL'){where.push('d.vertical=?');params.push(filters.vertical);}
 if(filters.search){where.push("(d.name LIKE ? ESCAPE '\\\\' OR d.code LIKE ? ESCAPE '\\\\')");const term=`%${filters.search.replace(/[\\%_]/g,'\\$&')}%`;params.push(term,term);}
 const predicate=where.join(' AND ');
 const [[rows],[[count]]]=await Promise.all([
 connection.query(`SELECT d.*,c.name category_name FROM specification_definitions d LEFT JOIN categories c ON c.id=d.category_id AND c.tenant_id=d.tenant_id WHERE ${predicate} ORDER BY d.sort_order,d.name,d.id LIMIT ? OFFSET ?`,[...params,filters.pageSize,(filters.page-1)*filters.pageSize]),
 connection.execute(`SELECT COUNT(*) total FROM specification_definitions d WHERE ${predicate}`,params)]);
 return {items:rows.map(map),total:Number(count.total),page:filters.page,pageSize:filters.pageSize,totalPages:Math.max(1,Math.ceil(Number(count.total)/filters.pageSize))};
}
export async function find({tenantId,definitionId,connection=getPrimaryPool()}){const [[row]]=await connection.execute('SELECT * FROM specification_definitions WHERE tenant_id=? AND id=?',[id(tenantId),id(definitionId)]);return row?map(row):null;}
export async function save({tenantId,definitionId,input,create,connection}){
 const mutable=[input.name,input.unit,input.group,input.helpText,JSON.stringify(input.options),input.customerVisible,input.filterable,input.sortOrder,input.status];
 if(create)await connection.execute(`INSERT INTO specification_definitions(name,unit,group_name,help_text,options_json,customer_visible,filterable,sort_order,status,tenant_id,id,code,vertical,category_id,data_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[...mutable,id(tenantId),id(definitionId),input.code,input.vertical,input.categoryId?id(input.categoryId):null,input.dataType]);
 else await connection.execute('UPDATE specification_definitions SET name=?,unit=?,group_name=?,help_text=?,options_json=?,customer_visible=?,filterable=?,sort_order=?,status=?,version=version+1 WHERE tenant_id=? AND id=?',[...mutable,id(tenantId),id(definitionId)]);
}
export async function usedValues({tenantId,definitionId,connection}){const [rows]=await connection.execute('SELECT DISTINCT value_json FROM product_specification_values WHERE tenant_id=? AND definition_id=?',[id(tenantId),id(definitionId)]);return rows.map(row=>json(row.value_json));}
export async function product({tenantId,productId,connection=getPrimaryPool(),lock=false}){
 const [[row]]=await connection.execute(`SELECT p.id,p.name,pt.vertical FROM products p JOIN product_types pt ON pt.id=p.product_type_id AND pt.tenant_id=p.tenant_id JOIN tenant_product_verticals tpv ON tpv.tenant_id=p.tenant_id AND tpv.vertical=pt.vertical AND tpv.status='ACTIVE' WHERE p.tenant_id=? AND p.id=? AND p.deleted_at IS NULL ${lock?'FOR UPDATE':''}`,[id(tenantId),id(productId)]);
 return row?{id:uuid(row.id),name:row.name,vertical:row.vertical}:null;
}
export async function applicable({tenantId,productId,connection=getPrimaryPool(),publicOnly=false}){
 const [rows]=await connection.execute(`SELECT d.* FROM specification_definitions d JOIN products p ON p.tenant_id=d.tenant_id AND p.id=? AND p.deleted_at IS NULL JOIN product_types pt ON pt.id=p.product_type_id AND pt.tenant_id=p.tenant_id AND pt.vertical=d.vertical
 WHERE d.tenant_id=? AND d.status='ACTIVE' AND (d.category_id IS NULL OR EXISTS(SELECT 1 FROM product_categories pc JOIN categories c ON c.id=pc.category_id AND c.tenant_id=d.tenant_id AND c.status='ACTIVE' AND c.deleted_at IS NULL WHERE pc.product_id=p.id AND pc.category_id=d.category_id))
 ${publicOnly?"AND d.customer_visible=1 AND p.publication_status='PUBLISHED' AND p.approval_status='APPROVED'":''} ORDER BY d.sort_order,d.name,d.id`,[id(productId),id(tenantId)]);
 return rows.map(map);
}
export async function values({tenantId,productId,connection=getPrimaryPool()}){const [rows]=await connection.execute('SELECT definition_id,value_json FROM product_specification_values WHERE tenant_id=? AND product_id=?',[id(tenantId),id(productId)]);return new Map(rows.map(row=>[uuid(row.definition_id),json(row.value_json)]));}
export async function version({tenantId,productId,connection=getPrimaryPool()}){const [[row]]=await connection.execute('SELECT version FROM product_specification_sets WHERE tenant_id=? AND product_id=?',[id(tenantId),id(productId)]);return Number(row?.version||0);}
export async function replace({tenantId,productId,definitions,entries,connection}){
 await connection.execute('INSERT INTO product_specification_sets(tenant_id,product_id) VALUES(?,?) ON DUPLICATE KEY UPDATE version=version+1',[id(tenantId),id(productId)]);
 // Leave inactive or no-longer-applicable values untouched, but never expose them publicly.
 for(const definition of definitions){await connection.execute('DELETE FROM product_specification_values WHERE tenant_id=? AND product_id=? AND definition_id=?',[id(tenantId),id(productId),id(definition.id)]);}
 for(const entry of entries)await connection.execute('INSERT INTO product_specification_values(tenant_id,product_id,definition_id,value_json) VALUES(?,?,?,?)',[id(tenantId),id(productId),id(entry.definitionId),JSON.stringify(entry.value)]);
}
