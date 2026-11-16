import {AppError} from '../../core/errors/app-error.js';
import {createId} from '../../core/identifiers/uuid.js';
import {withTransaction} from '../../database/transaction.js';
import {findAccount,audit} from '../customer-accounts/customer-accounts.dao.js';
import {shoppingEnabled} from '../shopping/shopping.dao.js';
import {resolveStore,cartOffers,wishlistProducts} from '../storefront/storefront.dao.js';
import {quantityIssue} from '../storefront-cart/storefront-cart.service.js';
import {enqueue} from '../notifications/inbox.dao.js';
import * as dao from './reminders.dao.js';
const fail=(code,message,status)=>{throw new AppError({code,message,status});};
const active=row=>row?.enabled&&Date.parse(row.expiresAt)>Date.now();
const view=(row,kind)=>({kind,enabled:Boolean(active(row)),status:!row?.enabled?'OFF':active(row)?'ACTIVE':'EXPIRED',version:row?.version||0,consentedAt:row?.consentedAt||null,expiresAt:row?.expiresAt||null,lastSentAt:row?.lastSentAt||null,delayHours:kind==='CART'?24:168,cooldownDays:7});
export async function settings(scope,account,_input,connection){const items=[];for(const kind of ['CART','WISHLIST'])items.push(view(await dao.preference({...scope,customerId:account.customerId,kind,connection}),kind));return {items};}
export async function consent(scope,account,input,connection){const a={...scope,customerId:account.customerId,...input,connection},current=await dao.preference({...a,lock:true});if((current?.version||0)!==input.version)fail('REMINDER_CHANGED','Reminder preferences changed. Refresh before saving.',409);if(input.enabled&&!await shoppingEnabled(a))fail('SHOPPING_NOTIFICATIONS_DISABLED','Enable Shopping alerts in notification preferences before opting in.',409);
 if(input.enabled&&!await dao.scope(a))fail('CUSTOMER_VERIFICATION_REQUIRED','Verify your customer account before enabling reminders.',401);
 if(input.enabled===Boolean(active(current)))return view(current,input.kind);
 await dao.save({...a,current});await audit({...a,action:input.enabled?'CUSTOMER_REMINDER_OPTED_IN':'CUSTOMER_REMINDER_OPTED_OUT'});return view(await dao.preference(a),input.kind);
}
export const adminList=(tenantId,input)=>dao.adminList({tenantId,...input});
export async function checkCandidate(candidate){return withTransaction(candidate.tenantId,async connection=>{
 const initial=await dao.find({...candidate,connection});if(!initial)return false;
 // Match cart/checkout and preference edits: account lock always precedes source locks.
 await findAccount({tenantId:initial.tenantId,customerId:initial.customerId,connection,lock:true});
 const pref=await dao.find({...candidate,connection,lock:true});if(!active(pref))return false;const a={...pref,connection};await dao.checked(a);
 const codes=await dao.scope(a);if(!codes||!await dao.due(a)||!await shoppingEnabled(a))return false;
 const source=await dao.source(a);if(!source?.items?.length||!source.sourceDue||!source.noPurchase||source.revision===pref.lastSourceRevision)return false;
 const scope=await resolveStore({...codes,connection});if(!scope)return false;
 let eligible;
 if(pref.kind==='CART'){const offers=await cartOffers({scope,offerIds:source.items.map(item=>item.offerId),connection});eligible=source.items.some(item=>{const offer=offers.find(row=>row.offerId===item.offerId);return offer&&!quantityIssue(offer,item.quantity);});}
 else {const products=await wishlistProducts({scope,productIds:source.items,connection});const offers=await cartOffers({scope,offerIds:products.map(product=>product.offerId),connection});eligible=offers.some(offer=>!quantityIssue(offer,offer.minimumOrderQuantity));}
 if(!eligible)return false;const eventId=createId();await dao.trigger({...a,eventId,source});
 await enqueue({connection,event:{tenantId:pref.tenantId,storeId:pref.storeId,key:`SHOPPING_REMINDER:${eventId}`,audience:'CUSTOMER',recipients:[pref.customerId],kind:`${pref.kind}_REMINDER`,category:'SHOPPING',entityType:'SHOPPING_REMINDER',entityId:eventId,title:pref.kind==='CART'?'Your bag is waiting for you':'Revisit your saved favourites',message:pref.kind==='CART'?'You opted in to a reminder about your saved bag. Available items were found at this check. Review current stock, quantities and prices before checkout. This is not a reservation.':'You opted in to a reminder about your wishlist. Available saved products were found at this check. Prices and availability can change. Open your wishlist to review them.'}});return true;
 });}
export function createReminderMonitor(){let cursor=null;return {async once(){const candidates=await dao.candidates({afterId:cursor});let queued=0,failed=0;for(const candidate of candidates){try{if(await checkCandidate(candidate))queued++;}catch{failed++;}cursor=candidate.preferenceId;}const cycleComplete=candidates.length<50;if(cycleComplete)cursor=null;return {scanned:candidates.length,queued,failed,cycleComplete};}};}
