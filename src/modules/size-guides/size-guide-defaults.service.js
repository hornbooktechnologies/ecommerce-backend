import {AppError} from '../../core/errors/app-error.js';
import {createId} from '../../core/identifiers/uuid.js';
import {withTransaction} from '../../database/transaction.js';
import {insertAudit} from '../catalog/catalog.dao.js';
import * as guides from './size-guides.dao.js';
import * as dao from './size-guide-defaults.dao.js';
const fail=(code,message,status)=>{throw new AppError({code,message,status});};
export const list=(tenantId,filters)=>dao.list({tenantId,filters});
export async function save(tenantId,ruleId,input,context){try{return await withTransaction(tenantId,async connection=>{
 const create=!ruleId,identifier=ruleId||createId();let previous=null;
 if(!create){previous=await dao.find({tenantId,ruleId,connection,lock:true});if(!previous)fail('SIZE_GUIDE_DEFAULT_NOT_FOUND','This default rule is unavailable.',404);if(previous.version!==input.version)fail('SIZE_GUIDE_DEFAULT_CHANGED','This rule changed. Reopen it before saving.',409);}
 if(!await dao.references({tenantId,input,connection}))fail('SIZE_GUIDE_DEFAULT_SCOPE','Choose brand/category values from this tenant. Active rules require active values.',422);
 const guide=await guides.find({tenantId,guideId:input.guideId,connection,lock:true});if(!guide)fail('SIZE_GUIDE_NOT_FOUND','This size guide is unavailable.',404);if(input.status==='ACTIVE'&&guide.status!=='ACTIVE')fail('SIZE_GUIDE_INACTIVE','Choose an active guide for an active default rule.',422);
 await dao.save({tenantId,ruleId:identifier,input,actorUserId:context.actorUserId,connection,create});const result=await dao.find({tenantId,ruleId:identifier,connection});
 await insertAudit({audit:{id:createId(),tenantId,entityId:identifier,entityType:'SIZE_GUIDE_DEFAULT',action:create?'catalog.size_guide.default.created':'catalog.size_guide.default.updated',beforeData:previous,afterData:result,actorUserId:context.actorUserId,requestId:context.requestId,ipAddress:context.ipAddress||null,userAgent:context.userAgent?.slice(0,500)||null},connection});return result;
 });}catch(error){if(error.code==='ER_DUP_ENTRY')fail('SIZE_GUIDE_DEFAULT_EXISTS','A rule already exists for this exact brand/category scope. Edit that rule instead.',409);throw error;}}
