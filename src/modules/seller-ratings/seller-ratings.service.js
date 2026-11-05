import {AppError} from '../../core/errors/app-error.js';
import {createId} from '../../core/identifiers/uuid.js';
import {withTransaction} from '../../database/transaction.js';
import {insertAudit} from '../vendors/vendors.dao.js';
import * as dao from './seller-ratings.dao.js';
const fail=(code,message,status)=>{throw new AppError({code,message,status});};
export const ownOrders=(scope,account,input,connection)=>dao.ownOrders({...scope,customerId:account.customerId,orderId:input.orderId,connection}).then(items=>({items}));
export async function submit(scope,account,input,connection){
 const args={...scope,customerId:account.customerId,orderId:input.orderId,sellerOrderId:input.sellerOrderId,connection};
 const purchase=await dao.purchase(args);if(!purchase)fail('SELLER_ORDER_UNAVAILABLE','This seller order is unavailable in your account.',404);
 const previous=await dao.existing(args);if(previous)return {review:previous,message:'Your seller rating has already been received.'};
 if(!purchase.eligible)fail('SELLER_RATING_NOT_ELIGIBLE','Rate this seller after all non-cancelled items in this seller order have been delivered.',422);
 const ratingId=createId();await dao.insert({...args,...purchase,ratingId,firstName:String(account.firstName||'Customer').slice(0,80),input});
 return {review:{id:ratingId,rating:input.rating,review:input.review,status:'PENDING'},message:'Thank you. Your seller rating is awaiting moderation.'};
}
export const list=(tenantId,filters)=>dao.list({tenantId,filters});
export async function moderate(tenantId,ratingId,input,actor){return withTransaction(tenantId,async connection=>{
 const current=await dao.find({tenantId,ratingId,connection,lock:true});if(!current)fail('SELLER_RATING_NOT_FOUND','This seller rating is unavailable.',404);
 if(current.version!==input.version)fail('SELLER_RATING_CHANGED','This rating changed. Reload the queue before moderating.',409);
 await dao.moderate({tenantId,ratingId,input,actorUserId:actor.actorUserId,connection});
 await insertAudit({audit:{id:createId(),tenantId,actorUserId:actor.actorUserId,entityType:'SELLER_RATING',entityId:ratingId,action:`seller.rating.${input.status.toLowerCase()}`,requestId:actor.requestId||null,ipAddress:actor.ipAddress||null,userAgent:actor.userAgent||null,beforeData:{status:current.status,version:current.version},afterData:{status:input.status,version:current.version+1,note:input.note}},connection});
 return dao.find({tenantId,ratingId,connection});
});}
