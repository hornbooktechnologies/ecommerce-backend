import {getPrimaryPool} from '../../database/pool-factory.js';
import {uuidToBuffer as id,bufferToUuid as uuid} from '../../core/identifiers/uuid.js';
import {AppError} from '../../core/errors/app-error.js';

export async function validateSpecificationFilters({scope,filters,connection=getPrimaryPool()}){
 const selected=filters.specs||[];if(!selected.length)return;
 const [rows]=await connection.query(`SELECT id,data_type,options_json FROM specification_definitions
 WHERE tenant_id=? AND id IN (${selected.map(()=>'?').join(',')}) AND status='ACTIVE'
 AND customer_visible=1 AND filterable=1 AND data_type IN ('SELECT','BOOLEAN','NUMBER')`,[id(scope.tenantId),...selected.map(item=>id(item.id))]);
 const definitions=new Map(rows.map(row=>[uuid(row.id),row]));
 for(const selection of selected){const definition=definitions.get(selection.id),options=definition?.data_type==='BOOLEAN'?['true','false']:definition?(typeof definition.options_json==='string'?JSON.parse(definition.options_json):definition.options_json):[];
  const valid=definition&&(definition.data_type==='NUMBER'?!selection.values&&(selection.min!==undefined||selection.max!==undefined):Array.isArray(selection.values)&&selection.min===undefined&&selection.max===undefined&&selection.values.every(value=>options.includes(value)));
  if(!valid)throw new AppError({code:'CATALOG_FILTER_UNAVAILABLE',message:'Some product filters have changed or are unavailable. Clear the specification filters and choose again.',status:422});
 }
}

// Product-level predicates compose with the existing SAME-offer colour/size/price
// predicates. Recheck visibility/scope in SQL to protect against configuration races.
export function specificationPredicate({scope,filters,values,productAlias='catalog'}){
 if(!['catalog'].includes(productAlias))throw new Error('Unsupported internal product alias');
 return (filters.specs||[]).map(selection=>{
  values.push(id(scope.tenantId),id(selection.id));
  let comparison;
  if(selection.values){values.push(...selection.values);comparison=`((sd.data_type='SELECT' AND JSON_TYPE(sv.value_json)='STRING') OR (sd.data_type='BOOLEAN' AND JSON_TYPE(sv.value_json)='BOOLEAN')) AND BINARY JSON_UNQUOTE(sv.value_json) IN (${selection.values.map(()=>'?').join(',')})`;}
  else {const bounds=[];if(selection.min!==undefined){bounds.push('(JSON_UNQUOTE(sv.value_json)+0e0)>=?');values.push(selection.min);}if(selection.max!==undefined){bounds.push('(JSON_UNQUOTE(sv.value_json)+0e0)<=?');values.push(selection.max);}comparison=`sd.data_type='NUMBER' AND JSON_TYPE(sv.value_json) IN ('INTEGER','DOUBLE') AND ABS(JSON_UNQUOTE(sv.value_json)+0e0)<=1e12 AND ${bounds.join(' AND ')}`;}
  return `EXISTS(SELECT 1 FROM product_specification_values sv
   JOIN specification_definitions sd ON sd.id=sv.definition_id AND sd.tenant_id=sv.tenant_id
   AND sd.status='ACTIVE' AND sd.customer_visible=1 AND sd.filterable=1
   WHERE sv.tenant_id=? AND sd.id=? AND sv.product_id=${productAlias}.id AND sd.vertical=${productAlias}.vertical
   AND (${comparison})
   AND (sd.category_id IS NULL OR EXISTS(SELECT 1 FROM product_categories fpc JOIN categories fc ON fc.id=fpc.category_id
    AND fc.tenant_id=sd.tenant_id AND fc.status='ACTIVE' AND fc.deleted_at IS NULL
    WHERE fpc.product_id=${productAlias}.id AND fpc.category_id=sd.category_id)))`;
 }).join(' AND ');
}

export function mapSpecificationFacets(rows){
 const groups=new Map();for(const row of rows){const key=uuid(row.id);if(!groups.has(key))groups.set(key,{id:key,name:row.name,type:row.data_type,unit:row.unit||'',options:[]});const group=groups.get(key);if(row.data_type==='NUMBER')group.range={min:Number(row.min_value),max:Number(row.max_value),count:Number(row.product_count)};else group.options.push({value:row.value,name:row.data_type==='BOOLEAN'?(row.value==='true'?'Yes':'No'):row.value,count:Number(row.product_count)});}
 return [...groups.values()];
}

// IDs come only from this store's eligible catalog query, not from the client.
// Disjoint batches bound SQL placeholders; summing per-product counts is exact.
export async function listSpecificationFacets({scope,products,connection=getPrimaryPool()}){
 const totals=new Map();
 for(let offset=0;offset<products.length;offset+=500){const batch=products.slice(offset,offset+500);
  const [rows]=await connection.query(`SELECT d.id,d.name,d.data_type,d.unit,d.sort_order,
   CASE WHEN d.data_type='NUMBER' THEN NULL ELSE JSON_UNQUOTE(v.value_json) END AS value,
   MIN(CASE WHEN d.data_type='NUMBER' THEN JSON_UNQUOTE(v.value_json)+0e0 END) min_value,
   MAX(CASE WHEN d.data_type='NUMBER' THEN JSON_UNQUOTE(v.value_json)+0e0 END) max_value,COUNT(DISTINCT p.id) AS product_count
   FROM product_specification_values v JOIN products p ON p.id=v.product_id AND p.tenant_id=v.tenant_id
   AND p.publication_status='PUBLISHED' AND p.approval_status='APPROVED' AND p.deleted_at IS NULL
   JOIN product_types pt ON pt.id=p.product_type_id AND pt.tenant_id=p.tenant_id AND pt.deleted_at IS NULL
   JOIN tenant_product_verticals tv ON tv.tenant_id=p.tenant_id AND tv.vertical=pt.vertical AND tv.status='ACTIVE'
   JOIN specification_definitions d ON d.id=v.definition_id AND d.tenant_id=v.tenant_id AND d.vertical=pt.vertical
   AND d.status='ACTIVE' AND d.customer_visible=1 AND d.filterable=1
   WHERE v.tenant_id=? AND v.product_id IN (${batch.map(()=>'?').join(',')})
   AND ((d.data_type='SELECT' AND JSON_TYPE(v.value_json)='STRING' AND JSON_CONTAINS(d.options_json,v.value_json))
    OR (d.data_type='BOOLEAN' AND JSON_TYPE(v.value_json)='BOOLEAN')
    OR (d.data_type='NUMBER' AND JSON_TYPE(v.value_json) IN ('INTEGER','DOUBLE') AND ABS(JSON_UNQUOTE(v.value_json)+0e0)<=1e12))
   AND (d.category_id IS NULL OR EXISTS(SELECT 1 FROM product_categories pc JOIN categories cat ON cat.id=pc.category_id
    AND cat.tenant_id=d.tenant_id AND cat.status='ACTIVE' AND cat.deleted_at IS NULL WHERE pc.product_id=p.id AND pc.category_id=d.category_id))
   GROUP BY d.id,d.name,d.data_type,d.unit,d.sort_order,CASE WHEN d.data_type='NUMBER' THEN NULL ELSE JSON_UNQUOTE(v.value_json) END`,[id(scope.tenantId),...batch.map(row=>row.id)]);
  for(const row of rows){const key=JSON.stringify([uuid(row.id),row.value]);const previous=totals.get(key);if(previous){previous.product_count+=Number(row.product_count);if(row.data_type==='NUMBER'){previous.min_value=Math.min(Number(previous.min_value),Number(row.min_value));previous.max_value=Math.max(Number(previous.max_value),Number(row.max_value));}}else totals.set(key,{...row,product_count:Number(row.product_count)});}
 }
 return mapSpecificationFacets([...totals.values()].sort((a,b)=>Number(a.sort_order)-Number(b.sort_order)||a.name.localeCompare(b.name)||uuid(a.id).localeCompare(uuid(b.id))||String(a.value??'').localeCompare(String(b.value??''))));
}
