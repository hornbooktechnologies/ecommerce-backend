import {createHash} from 'node:crypto';
import Joi from 'joi';
import {AppError} from '../../core/errors/app-error.js';
import {createId} from '../../core/identifiers/uuid.js';
import {withTransaction} from '../../database/transaction.js';
import {insertAudit} from '../catalog/catalog.dao.js';
import * as dao from './specifications.dao.js';
const fail=(code,message,status=422)=>{throw new AppError({code,message,status});};
const revision=definitions=>createHash('sha256').update(JSON.stringify(definitions.map(d=>[d.id,d.version]))).digest('hex');
async function audit(tenantId,entityId,action,context,connection){await insertAudit({audit:{id:createId(),tenantId,entityId,entityType:'SPECIFICATION',action,afterData:{entityId},actorUserId:context.actorUserId,requestId:context.requestId,ipAddress:context.ipAddress||null,userAgent:context.userAgent?.slice(0,500)||null},connection});}
export const list=(tenantId,filters)=>dao.list({tenantId,filters});
export async function save(tenantId,definitionId,input,context){
 return withTransaction(tenantId,async connection=>{
  await dao.lockTenant({tenantId,connection});
  if(!await dao.scopes({tenantId,vertical:input.vertical,categoryId:input.categoryId,connection}))fail('SPECIFICATION_SCOPE','Choose an enabled product type and an active category in this tenant.');
  const create=!definitionId,id=definitionId||createId();
  if(!create){const current=await dao.find({tenantId,definitionId,connection});if(!current)fail('SPECIFICATION_NOT_FOUND','This specification could not be found.',404);
   if(current.version!==input.version)fail('SPECIFICATION_CHANGED','This definition changed. Reopen it before saving.',409);
   if(['code','vertical','categoryId','dataType'].some(key=>current[key]!==input[key]))fail('SPECIFICATION_IMMUTABLE','Code, type and scope cannot change. Create a new definition instead.');
   if(current.unit!==input.unit&&(await dao.usedValues({tenantId,definitionId,connection})).length)fail('SPECIFICATION_UNIT_IN_USE','Units cannot change after values have been entered. Create a new definition to avoid mislabelling measurements.');
   if(input.dataType==='SELECT'&&(await dao.usedValues({tenantId,definitionId,connection})).some(value=>!input.options.includes(value)))fail('SPECIFICATION_OPTION_IN_USE','An option is used by a product. Keep it, or clear those product values first.');
  }
  try{await dao.save({tenantId,definitionId:id,input,create,connection});}catch(error){if(error.code==='ER_DUP_ENTRY')fail('SPECIFICATION_CODE_EXISTS','This code already exists. Use a unique tenant-wide code.',409);throw error;}
  await audit(tenantId,id,create?'catalog.specification.created':'catalog.specification.updated',context,connection);
  return dao.find({tenantId,definitionId:id,connection});
 });
}
export async function assignment(tenantId,productId){
 return withTransaction(tenantId,async connection=>{
 await dao.lockTenant({tenantId,connection});
 const product=await dao.product({tenantId,productId,connection,lock:true});if(!product)fail('PRODUCT_NOT_FOUND','The product could not be found.',404);
 const [definitions,values,version]=await Promise.all([dao.applicable({tenantId,productId,connection}),dao.values({tenantId,productId,connection}),dao.version({tenantId,productId,connection})]);
 return {product,definitions:definitions.map(d=>({...d,value:values.has(d.id)?values.get(d.id):null})),version,definitionRevision:revision(definitions)};
 });
}
function typed(definition,value){
 let valid=false;
 switch(definition.dataType){
 case 'TEXT':valid=typeof value==='string'&&value.trim().length>0&&value.trim().length<=2000;value=typeof value==='string'?value.trim():value;break;
 case 'NUMBER':valid=typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12;break;
 case 'BOOLEAN':valid=typeof value==='boolean';break;
 case 'SELECT':valid=typeof value==='string'&&definition.options.includes(value);break;
 case 'DATE':valid=typeof value==='string'&&!Joi.string().isoDate().validate(value).error&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;break;
 }
 if(!valid)fail('SPECIFICATION_VALUE',`Enter a valid ${definition.dataType.toLowerCase()} value for ${definition.name}.`);
 return value;
}
export async function assign(tenantId,productId,input,context){return withTransaction(tenantId,async connection=>{
 // Serialize definition and value edits under the same tenant lock before taking a product lock.
 await dao.lockTenant({tenantId,connection});
 if(!await dao.product({tenantId,productId,connection,lock:true}))fail('PRODUCT_NOT_FOUND','The product could not be found.',404);
 const definitions=await dao.applicable({tenantId,productId,connection});
 if(input.version!==await dao.version({tenantId,productId,connection})||input.definitionRevision!==revision(definitions))fail('PRODUCT_SPECIFICATIONS_CHANGED','Specifications changed. Reopen this form before saving.',409);
 const lookup=new Map(definitions.map(d=>[d.id,d]));
 const entries=input.values.map(entry=>{const definition=lookup.get(entry.definitionId);if(!definition)fail('SPECIFICATION_NOT_APPLICABLE','One of these fields is inactive or does not apply to this product.');return {...entry,value:typed(definition,entry.value)};});
 await dao.replace({tenantId,productId,definitions,entries,connection});
 await audit(tenantId,productId,'catalog.product.specifications.updated',context,connection);
 return {productId,version:input.version+1};
});}
export async function publicSpecifications({tenantId,productId}){
 const [definitions,values]=await Promise.all([dao.applicable({tenantId,productId,publicOnly:true}),dao.values({tenantId,productId})]);
 return definitions.filter(d=>values.has(d.id)).map(d=>({code:d.code,label:d.name,group:d.group,unit:d.unit,type:d.dataType,value:values.get(d.id),
  displayValue:d.dataType==='BOOLEAN'?(values.get(d.id)?'Yes':'No'):`${values.get(d.id)}${d.unit?` ${d.unit}`:''}`}));
}
