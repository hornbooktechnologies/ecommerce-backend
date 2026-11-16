import {createHash} from 'node:crypto';
import {AppError} from '../../core/errors/app-error.js';
import {createId} from '../../core/identifiers/uuid.js';
import {withTransaction} from '../../database/transaction.js';
import {resolveStore,findProduct} from '../storefront/storefront.dao.js';
import {insertAudit} from '../catalog/catalog.dao.js';
import * as accountDao from '../customer-accounts/customer-accounts.dao.js';
import * as inbox from '../notifications/inbox.dao.js';
import * as dao from './questions.dao.js';
const fail=(code,message,status=422)=>{throw new AppError({code,message,status});};
async function required(args){const question=await dao.find(args);if(!question)fail('QUESTION_NOT_FOUND','This question is unavailable in your workspace.',404);return question;}
function changed(question,version){if(question.version!==version)fail('QUESTION_CHANGED','This question changed. Reload it before continuing.',409);if(question.status==='WITHDRAWN')fail('QUESTION_WITHDRAWN','The customer withdrew this question.',409);}
async function eligible(question,tenantId,connection){const scope=await dao.store({tenantId,storeId:question.storeId,connection});if(!scope||!await findProduct({scope,slug:question.productSlug,connection}))fail('QUESTION_PRODUCT_UNAVAILABLE','The store or product is not currently available to customers.',409);}
async function audit(tenantId,questionId,action,context,connection){await insertAudit({audit:{id:createId(),tenantId,entityId:questionId,entityType:'PRODUCT_QUESTION',action,afterData:{questionId},actorUserId:context.actorUserId,requestId:context.requestId,ipAddress:context.ipAddress||null,userAgent:context.userAgent?.slice(0,500)||null},connection});}
async function notify(question,tenantId,kind,connection,{answerId}={}){
 const event={tenantId,storeId:question.storeId,entityType:'PRODUCT_QUESTION',entityId:question.id,category:'QUESTIONS',kind,
  key:`question:${question.id}:${kind}:${answerId||question.version}`,message:'Open product questions to review the latest update.'};
 if(kind==='QUESTION_ANSWER_PUBLISHED'){
  await inbox.enqueue({event:{...event,audience:'CUSTOMER',title:'Your product question has an answer',message:'A moderated answer is available in My questions.',recipients:[question.customerId]},connection});
 }else if(kind==='QUESTION_APPROVED'){
  for(const vendor of await dao.vendorIds({tenantId,questionId:question.id,connection}))await inbox.enqueue({event:{...event,key:`${event.key}:${vendor}`,audience:'VENDOR',merchantId:vendor,permission:'vendor.question.read',title:'A product question is ready to answer',recipients:await inbox.staffRecipients({tenantId,merchantId:vendor,permission:'vendor.question.answer',connection})},connection});
 }else await inbox.enqueue({event:{...event,audience:'ADMIN',permission:'question.read',title:kind==='QUESTION_SUBMITTED'?'New product question':'An answer needs review',recipients:await inbox.staffRecipients({tenantId,permission:'question.moderate',connection})},connection});
}
export const list=(scope,filters)=>dao.list({...scope,filters});
export async function detail(scope,questionId,filters){const question=await required({...scope,questionId});const answers=await dao.answers({...scope,questionId,filters});delete question.customerId;if(scope.merchantId){delete question.moderationNote;delete question.pendingAnswers;}return {question,answers};}
export async function ask(store,account,input,connection){
 const product=await findProduct({scope:store,slug:input.productSlug,connection});if(!product)fail('PRODUCT_NOT_FOUND','This product is unavailable in this store.',404);
 const question=input.question.trim(),hash=createHash('sha256').update(question.replace(/\s+/g,' ').toLocaleLowerCase('en-IN')).digest(),args={...store,productId:product.id,customerId:account.customerId,connection};
 const previous=await dao.duplicate({...args,hash});if(previous)return {question:previous,message:'This question has already been received. Check My questions.'};
 if(await dao.dailyCount(args)>=10)fail('QUESTION_LIMIT','You can submit up to ten product questions per day. Please try again later.',429);
 const questionId=createId();await dao.insertQuestion({...args,questionId,question,hash});
 await accountDao.audit({...args,action:'CUSTOMER_PRODUCT_QUESTION_SUBMITTED'});
 const saved=await required({tenantId:store.tenantId,questionId,connection});await notify(saved,store.tenantId,'QUESTION_SUBMITTED',connection);
 return {question:{id:questionId,status:'PENDING'},message:'Your question was submitted for review. Follow it in My questions.'};
}
export const mine=(store,account,filters,connection)=>dao.mine({...store,customerId:account.customerId,filters,connection});
export async function withdraw(store,account,input,connection){
 const question=await required({tenantId:store.tenantId,questionId:input.questionId,connection,lock:true});
 if(question.storeId!==store.storeId||question.customerId!==account.customerId)fail('QUESTION_NOT_FOUND','This question is unavailable in your account.',404);
 if(question.status==='WITHDRAWN')return {message:'Question withdrawn.'};
 changed(question,input.version);await dao.moderateQuestion({tenantId:store.tenantId,questionId:question.id,status:'WITHDRAWN',note:'Withdrawn by customer.',connection});await accountDao.audit({...store,customerId:account.customerId,action:'CUSTOMER_PRODUCT_QUESTION_WITHDRAWN',connection});
 return {message:'Your question was withdrawn and is no longer public.'};
}
export async function answer(scope,questionId,input,context){return withTransaction(scope.tenantId,async connection=>{
 const question=await required({...scope,questionId,connection,lock:true});changed(question,input.version);
 if(['HIDDEN','REJECTED'].includes(question.status))fail('QUESTION_NOT_OPEN','Approve this question before submitting an answer.',409);
 await eligible(question,scope.tenantId,connection);
 if(await dao.pendingOwn({...scope,questionId,actorUserId:context.actorUserId,connection}))fail('ANSWER_PENDING','You already have an answer awaiting review. Ask a moderator to review it first.',409);
 const answerId=createId();await dao.insertAnswer({...scope,questionId,answerId,actorUserId:context.actorUserId,body:input.body,connection});
 await audit(scope.tenantId,questionId,'question.answer.submitted',context,connection);
 await notify({...question,version:question.version+1},scope.tenantId,'QUESTION_ANSWER_SUBMITTED',connection,{answerId,merchantId:scope.merchantId});
 return {answerId,message:'Answer submitted for moderation.'};
});}
export async function moderate(scope,questionId,input,context){return withTransaction(scope.tenantId,async connection=>{
 const question=await required({...scope,questionId,connection,lock:true});changed(question,input.version);
 if(input.status==='APPROVED')await eligible(question,scope.tenantId,connection);
 if(question.status===input.status)return {message:'Question status is unchanged.'};
 await dao.moderateQuestion({...scope,questionId,status:input.status,note:input.note,actorUserId:context.actorUserId,connection});
 await audit(scope.tenantId,questionId,`question.${input.status.toLowerCase()}`,context,connection);
 if(input.status==='APPROVED')await notify({...question,version:question.version+1},scope.tenantId,'QUESTION_APPROVED',connection);
 return {message:input.status==='APPROVED'?'Question approved. It becomes public only with a published answer.':'Question hidden from the storefront.'};
});}
export async function moderateAnswer(scope,questionId,answerId,input,context){return withTransaction(scope.tenantId,async connection=>{
 const question=await required({...scope,questionId,connection,lock:true});changed(question,input.version);
 const candidate=await dao.answer({...scope,questionId,answerId,connection});if(!candidate)fail('ANSWER_NOT_FOUND','This answer is unavailable.',404);
 if(candidate.status!=='PENDING')fail('ANSWER_ALREADY_REVIEWED','This answer has already been reviewed. Reload the question.',409);
 if(input.status==='PUBLISHED'){
  await eligible(question,scope.tenantId,connection);
  if(candidate.merchantId&&!await dao.eligibleVendor({...scope,questionId,merchantId:candidate.merchantId,connection}))fail('ANSWER_VENDOR_UNAVAILABLE','This seller no longer has an eligible active offer for this product in this store.',409);
  if(question.status!=='APPROVED')await dao.moderateQuestion({...scope,questionId,status:'APPROVED',note:'Approved with published answer.',actorUserId:context.actorUserId,connection});
 }
 await dao.moderateAnswer({...scope,questionId,answerId,status:input.status,note:input.note,actorUserId:context.actorUserId,connection});
 await audit(scope.tenantId,questionId,`question.answer.${input.status.toLowerCase()}`,context,connection);
 if(input.status==='PUBLISHED')await notify(question,scope.tenantId,'QUESTION_ANSWER_PUBLISHED',connection,{answerId});
 return {message:input.status==='PUBLISHED'?'Question and answer published.':'Answer rejected. It remains private.'};
});}
export async function publicList(params,slug,filters){const scope=await resolveStore(params);if(!scope)fail('STORE_NOT_FOUND','This store is unavailable.',404);const product=await findProduct({scope,slug});if(!product)fail('PRODUCT_NOT_FOUND','This product is unavailable.',404);return dao.publicList({...scope,productId:product.id,filters});}
