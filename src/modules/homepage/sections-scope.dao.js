import {getPrimaryPool} from '../../database/pool-factory.js';
import {uuidToBuffer as id,bufferToUuid as uuid} from '../../core/identifiers/uuid.js';

export async function collectionScope({tenantId,section,connection=getPrimaryPool()}){
 const filters={};
 if(section.brandId){const [[brand]]=await connection.execute("SELECT id FROM brands WHERE tenant_id=? AND id=? AND status='ACTIVE' AND deleted_at IS NULL",[id(tenantId),id(section.brandId)]);if(!brand)return null;filters.brand=section.brandId;}
 if(section.categoryId){const [[category]]=await connection.execute("SELECT slug FROM categories WHERE tenant_id=? AND id=? AND status='ACTIVE' AND deleted_at IS NULL",[id(tenantId),id(section.categoryId)]);if(!category)return null;filters.category=category.slug;}
 if(section.inStockOnly)filters.inStock=true;
 return filters;
}
export async function collectionChoices({tenantId,search='',brandId=null,categoryId=null,connection=getPrimaryPool()}){
 const term=`%${search.replace(/[\\%_]/g,'\\$&')}%`,result={};
 for(const [table,selected]of [['brands',brandId],['categories',categoryId]]){
  const [rows]=await connection.query(`SELECT id,name FROM ${table} WHERE tenant_id=? AND status='ACTIVE' AND deleted_at IS NULL
   AND (name LIKE ? ESCAPE '\\\\' OR id=?) ORDER BY (id=?) DESC,name,id LIMIT 101`,[id(tenantId),term,selected?id(selected):null,selected?id(selected):null]);
  result[table]=rows.slice(0,100).map(row=>({id:uuid(row.id),name:row.name}));result[`${table}HasMore`]=rows.length>100;
 }return result;
}
