import Decimal from 'decimal.js';
import {AppError} from '../../core/errors/app-error.js';
import {createId} from '../../core/identifiers/uuid.js';
import {withTransaction} from '../../database/transaction.js';
import * as catalog from '../storefront/storefront.dao.js';
import * as dao from './shopping.dao.js';
import {audit} from '../customer-accounts/customer-accounts.dao.js';
import {enqueue} from '../notifications/inbox.dao.js';
const fail=(code,message,status=422)=>{throw new AppError({code,message,status});};
const dto=({cycleId,customerId,tenantId,storeId,...value})=>value;
const sellable=offer=>offer&&Math.min(offer.availableQuantity,offer.maximumOrderQuantity??offer.availableQuantity)>=offer.minimumOrderQuantity;
export async function offerSubscriptions(scope,account,input,connection){return {items:(await dao.offerSubscriptions({...scope,customerId:account.customerId,...input,connection})).map(dto)};}
export async function discovery(scope,input,connection){
 const ids=input.recentIds||[],wanted=[...new Set([input.currentProductId,...ids].filter(Boolean))];
 const products=await catalog.wishlistProducts({scope,productIds:wanted,connection});const byId=new Map(products.map(p=>[p.id,p]));
 const recent=ids.map(id=>byId.get(id)).filter(Boolean),seeds=wanted.map(id=>byId.get(id)).filter(Boolean).slice(0,5);
 return {recent:recent.filter(p=>p.id!==input.currentProductId),recommendations:await catalog.recommendedProducts({scope,seeds,excludeIds:wanted,connection}),retentionDays:30};
}
export async function personalDiscovery(scope,account,input,connection){const a={...scope,customerId:account.customerId,connection},preference=await dao.historyPreference(a);const recentIds=preference.enabled?await dao.recent(a):[];return {...await discovery(scope,{...input,recentIds},connection),history:preference};}
export async function view(scope,account,input,connection){const a={...scope,customerId:account.customerId,connection};const setting=await dao.historyPreference(a);if(setting.enabled){if(!(await catalog.wishlistProducts({scope,productIds:[input.productId],connection})).length)fail('PRODUCT_UNAVAILABLE','This product is unavailable.',404);await dao.view({...a,...input});}return {recorded:setting.enabled};}
export async function clear(scope,account,connection){const a={...scope,customerId:account.customerId,connection};await dao.clear(a);await audit({...a,action:'CUSTOMER_HISTORY_CLEARED'});return {cleared:true};}
export async function historySettings(scope,account,input,connection){const a={...scope,customerId:account.customerId,connection};if((await dao.historyPreference(a)).version!==input.version)fail('HISTORY_CHANGED','History settings changed. Refresh and try again.',409);await dao.saveHistoryPreference({...a,...input});await audit({...a,action:input.enabled?'CUSTOMER_HISTORY_ENABLED':'CUSTOMER_HISTORY_DISABLED'});return dao.historyPreference(a);}
export async function list(scope,account,input,connection){const a={...scope,customerId:account.customerId,...input,connection},result=await dao.list(a),offers=await catalog.cartOffers({scope,offerIds:[...new Set(result.items.map(s=>s.offerId))],connection});const byId=new Map(offers.map(o=>[o.offerId,o]));return {...result,items:result.items.map(s=>{const offer=byId.get(s.offerId);return {...dto(s),product:offer?{slug:offer.slug,name:offer.name,variant:offer.variantName,sellerName:offer.sellerName,price:offer.price,inStock:sellable(offer)}:null};})};}
export async function subscribe(scope,account,input,connection){
 const a={...scope,customerId:account.customerId,...input,connection};
 if(!await dao.shoppingEnabled(a))fail('SHOPPING_NOTIFICATIONS_DISABLED','Enable Shopping alerts in your notification preferences before subscribing.',409);
 const [offer]=await catalog.cartOffers({scope,offerIds:[input.offerId],connection});if(!offer)fail('OFFER_UNAVAILABLE','This seller option is unavailable.',404);
 const previous=await dao.findSubscription(a);if(previous?.status==='ACTIVE'&&new Date(previous.expiresAt).getTime()>Date.now())return {subscription:dto(previous),message:'This alert is already active.'};
 if(previous&&input.version!==previous.version)fail('ALERT_CHANGED','Refresh alerts before re-arming this subscription.',409);
 if(input.kind==='BACK_IN_STOCK'&&sellable(offer))fail('ALREADY_IN_STOCK','This seller option is already in stock. Refresh the product page.',409);
 if(await dao.activeCount(a)>=50)fail('ALERT_LIMIT','You can have up to fifty active shopping alerts per store.',409);
 await dao.saveSubscription({...a,previous,price:offer.price,currency:scope.currency});await audit({...a,action:'CUSTOMER_SHOPPING_ALERT_SUBSCRIBED'});return {subscription:dto(await dao.findSubscription(a)),message:'In-app alert enabled for this seller option. It expires after 90 days or one notification.'};
}
export async function cancel(scope,account,input,connection){const a={...scope,customerId:account.customerId,...input,connection},current=await dao.findSubscription(a);if(!current)fail('ALERT_NOT_FOUND','This alert is unavailable.',404);if(current.status==='CANCELLED')return {cancelled:true};if(current.version!==input.version)fail('ALERT_CHANGED','This alert changed. Refresh before cancelling.',409);await dao.cancel(a);await audit({...a,action:'CUSTOMER_SHOPPING_ALERT_CANCELLED'});return {cancelled:true};}
export async function adminList(tenantId,input){const {getPrimaryPool}=await import('../../database/pool-factory.js');return dao.list({tenantId,admin:true,...input,connection:getPrimaryPool()});}
export function createShoppingMonitor(){let cursor=null;return {async once(){const batch=await dao.candidates({afterId:cursor});let queued=0,failed=0;
 for(const candidate of batch){try{const didQueue=await withTransaction(candidate.tenantId,async connection=>{const sub=await dao.lockCandidate({...candidate,connection});if(!sub)return false;const scope=await catalog.resolveStore({tenantCode:sub.tenantCode,storeCode:sub.storeCode,connection});const [offer]=await catalog.cartOffers({scope,offerIds:[sub.offerId],connection});const a={...candidate,connection};await dao.checked(a);if(!offer||!sellable(offer)||offer.currency!==sub.currency)return false;
 if(sub.kind==='PRICE_DROP'&&!new Decimal(offer.price).lt(sub.baselinePrice))return false;
 if(!await dao.shoppingEnabled({...sub,connection}))return false;
 const eventId=createId();await dao.trigger({...a,eventId,cycleId:sub.cycleId,price:offer.price});const title=sub.kind==='BACK_IN_STOCK'?'Your selected option is back in stock':'Price dropped on your selected option';
 await enqueue({event:{tenantId:sub.tenantId,storeId:sub.storeId,key:`SHOPPING_ALERT:${eventId}`,audience:'CUSTOMER',recipients:[sub.customerId],kind:sub.kind,category:'SHOPPING',entityType:'SHOPPING_ALERT',entityId:eventId,title,message:`${offer.name.slice(0,120)} · ${String(offer.variantName||offer.sku).slice(0,100)} · ${offer.sellerName.slice(0,100)}. ${sub.currency} ${new Decimal(offer.price).toFixed(2)} at detection. Stock and price can change; this is not a reservation.`},connection});return true;});if(didQueue)queued++;}catch{failed++;}cursor=candidate.subscriptionId;}
 const cycleComplete=batch.length<100;if(cycleComplete)cursor=null;return {scanned:batch.length,queued,failed,cycleComplete};}};}
