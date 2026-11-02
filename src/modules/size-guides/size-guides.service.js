import {AppError} from '../../core/errors/app-error.js';
import {createId} from '../../core/identifiers/uuid.js';
import {withTransaction} from '../../database/transaction.js';
import {insertAudit} from '../catalog/catalog.dao.js';
import * as dao from './size-guides.dao.js';

const fail=(code,message,status)=>{throw new AppError({code,message,status});};
const requiredGuide=async(input)=>{const guide=await dao.find(input);if(!guide)fail('SIZE_GUIDE_NOT_FOUND','The size guide could not be found.',404);return guide;};
const requiredProduct=async(input)=>{const product=await dao.product(input);if(!product)fail('PRODUCT_NOT_FOUND','The product could not be found.',404);if(product.vertical!=='CLOTHING')fail('SIZE_GUIDE_PRODUCT_TYPE','Size guides can only be assigned to clothing products.',422);return product;};
async function audit({tenantId,entityId,action,afterData,context,connection}) {
 await insertAudit({audit:{id:createId(),tenantId,entityId,entityType:'SIZE_GUIDE',action,afterData,actorUserId:context.actorUserId,requestId:context.requestId,ipAddress:context.ipAddress||null,userAgent:context.userAgent?.slice(0,500)||null},connection});
}
export const list=(tenantId,filters)=>dao.list({tenantId,filters});
export const detail=(tenantId,guideId)=>requiredGuide({tenantId,guideId});
export async function save(tenantId,guideId,input,context) {
 const create=!guideId,id=guideId||createId();
 return withTransaction(tenantId,async connection=>{
  if(!create){const current=await requiredGuide({tenantId,guideId:id,connection,lock:true});if(current.version!==input.version)fail('SIZE_GUIDE_CHANGED','This guide changed. Reopen it before saving.',409);}
  await dao.save({tenantId,guideId:id,input,connection,create});
  const guide=await dao.find({tenantId,guideId:id,connection});
  await audit({tenantId,entityId:id,action:create?'catalog.size_guide.created':'catalog.size_guide.updated',afterData:{guideId:id,name:guide.name,status:guide.status,version:guide.version},context,connection});
  return guide;
 });
}
export async function assignment(tenantId,productId) {
 const product=await requiredProduct({tenantId,productId});
 const guideId=await dao.binding({tenantId,productId});
 return {product,guideId,guide:guideId?await dao.find({tenantId,guideId}):null};
}
export async function assign(tenantId,productId,input,context) {
 return withTransaction(tenantId,async connection=>{
  await requiredProduct({tenantId,productId,connection,lock:true});
  const previous=await dao.binding({tenantId,productId,connection});
  if(previous!==input.previousGuideId)fail('SIZE_GUIDE_ASSIGNMENT_CHANGED','This assignment changed. Reopen it before saving.',409);
  if(input.guideId){const guide=await requiredGuide({tenantId,guideId:input.guideId,connection,lock:true});if(guide.status!=='ACTIVE')fail('SIZE_GUIDE_INACTIVE','Choose an active size guide.',422);}
  await dao.bind({tenantId,productId,guideId:input.guideId,connection});
  await audit({tenantId,entityId:productId,action:'catalog.product.size_guide.changed',afterData:{productId,previousGuideId:previous,guideId:input.guideId},context,connection});
  return {productId,guideId:input.guideId};
 });
}
