import Decimal from 'decimal.js';
import {createHash} from 'node:crypto';
import {AppError} from '../../core/errors/app-error.js';
import {createId} from '../../core/identifiers/uuid.js';
import {withTransaction} from '../../database/transaction.js';
import {normalizeGstStateCode} from '../../core/india/gst.js';
import * as defaultDao from './order-substitutions.dao.js';
import * as defaultOrderDao from './orders.dao.js';
import {calculateIncludedTax} from './orders.service.js';

const fail=(code,message,status=409)=>{throw new AppError({code,message,status});};
const available=({balance,lots})=>{
  if(!balance)return new Decimal(0);
  const usable=r=>Decimal.max(0,new Decimal(r.on_hand_quantity).minus(r.reserved_quantity).minus(r.quarantine_quantity));
  const total=balance.lot_tracking_enabled ? Decimal.min(usable(balance),lots.reduce((s,r)=>s.plus(usable(r)),new Decimal(0))) : usable(balance);
  return Decimal.max(0,total.minus(balance.safety_stock_quantity||0));
};
function blocked(c) {
  if(!c.active_store)return 'This store is inactive. Reopen it before reviewing replacements.';
  if(c.already_substituted)return 'This item has already been replaced. Further replacements need separate review.';
  if(!['PLACED','CONFIRMED'].includes(c.order_status)||c.status!=='PENDING'||c.fulfillment_status!=='UNFULFILLED'||c.has_fulfillment)
    return 'Replace items before any warehouse allocation. Allocated, dispatched and closed orders cannot be changed here.';
  if(c.payment_status!=='UNPAID'||(c.payment_method!==null&&c.payment_method!=='COD')||c.has_payment)
    return 'Only unpaid COD or manual orders without collected/authorised payments can be replaced here. Paid/online orders need a payment-adjustment workflow.';
  if(c.has_invoice||c.has_return)return 'An invoice or return already exists. Use the after-sales process instead.';
  if(c.has_promotion||c.product.promotion)return 'Orders using offers or coupons need promotion revalidation; replacement is unavailable here.';
  if(c.currency!=='INR')return 'This flow supports INR orders only.';
  if(!c.prices_include_tax)return 'This order needs tax-exclusive repricing review; replacement is unavailable here.';
  if(c.vertical!=='GROCERY'||c.product_kind!=='STANDARD'||!c.allows_substitutions)
    return 'Only standard grocery products with substitutions enabled can be replaced.';
  if(!['ALLOW_SIMILAR','CONTACT_ME'].includes(c.substitution_preference))return 'The customer has not permitted substitutions for this item.';
  return null;
}
export function createOrderSubstitutionsService({dao=defaultDao,orderDao=defaultOrderDao,transaction=withTransaction}={}) {
  async function load(tenantId,orderId,itemId,connection){
    const c=await dao.context({tenantId,orderId,itemId,connection});
    if(!c)fail('ORDER_ITEM_NOT_FOUND','This order item was not found.',404);
    return c;
  }
  async function choice(tenantId,c,r,warehouseId,connection) {
    const base={offerId:r.offerId,ruleId:r.ruleId,priority:r.priority,productName:r.product_name,
      variantName:r.variant_name,sku:r.sku,maximumPriceDifferencePercent:r.maximumPriceDifferencePercent};
    const reject=reason=>({...base,eligible:false,reason});
    if(r.sellingUomId!==c.sellingUomId||Boolean(r.sold_by_weight)!==Boolean(c.sold_by_weight)||r.serial_tracking_enabled)
      return reject('Replacement needs the same selling unit/weight basis and cannot be serial tracked.');
    const offers=await orderDao.findOffersForOrder({tenantId,storeId:c.storeId,offerIds:[r.offerId],destinationStateCode:normalizeGstStateCode(c.address.stateCode),connection});
    if(offers.length!==1)return reject('A unique current price is unavailable.');
    const offer=offers[0],quantity=new Decimal(c.quantity),originalUnit=new Decimal(c.unit_price),sale=new Decimal(offer.salePrice);
    if(!offer.hsnSacCode||!offer.taxCategoryId||!offer.taxRateId||!offer.registrationGstin||!normalizeGstStateCode(offer.registrationStateCode))
      return reject('Replacement needs an effective tax category, GST rate and seller registration.');
    if(quantity.lessThan(offer.minimumOrderQuantity)||(offer.maximumOrderQuantity!==null&&quantity.greaterThan(offer.maximumOrderQuantity))
      ||!quantity.minus(offer.minimumOrderQuantity).modulo(offer.quantityStep).isZero())return reject('The original quantity does not meet this replacement’s quantity rules.');
    if(r.maximumPriceDifferencePercent!==null&&sale.greaterThan(originalUnit.times(new Decimal(1).plus(new Decimal(r.maximumPriceDifferencePercent).div(100)))))
      return reject(`Current replacement price exceeds the configured ${r.maximumPriceDifferencePercent}% increase limit.`);
    const weight=offer.soldByWeight?quantity:new Decimal(offer.estimatedWeight||0).times(quantity);
    if(!weight.equals(new Decimal(c.estimated_weight||0)))return reject('Replacement changes delivery weight; separate weight/slot review is required.');
    const usable=available(await dao.stock({tenantId,warehouseId,offerId:r.offerId,connection}));
    if(usable.lessThan(quantity))return {...reject('Not enough unreserved, unexpired stock in this warehouse.'),availableQuantity:usable.toNumber()};
    const unitPrice=Decimal.min(originalUnit,sale);
    if(new Decimal(offer.listPrice).lessThan(unitPrice))return reject('Replacement selling price exceeds its current MRP. Correct pricing first.');
    return {...base,eligible:true,reason:null,availableQuantity:usable.toNumber(),salePrice:sale.toNumber(),
      unitPrice:unitPrice.toNumber(),lineTotal:unitPrice.times(quantity).toDecimalPlaces(4).toNumber(),
      merchantAbsorbsIncrease:sale.greaterThan(originalUnit),offer};
  }
  async function options(tenantId,orderId,itemId,warehouseId) {
    return transaction(tenantId,async connection=>{
      const c=await load(tenantId,orderId,itemId,connection),reason=blocked(c);
      const base={orderVersion:c.orderVersion,itemId,productName:c.product_name,quantity:Number(c.quantity),
        originalUnitPrice:Number(c.unit_price),originalLineTotal:Number(c.line_total),orderTotal:Number(c.grand_total),
        preference:c.substitution_preference,requiresApproval:c.substitution_preference==='CONTACT_ME',
        message:'Stock is checked again when applying and allocating. Applying alone does not reserve stock. Your customer is never charged more.'};
      if(reason)return {...base,blockedReason:reason,warehouses:[],candidates:[]};
      const warehouses=await dao.warehouses({tenantId,storeId:c.storeId,merchantId:c.merchantId,connection});
      const selected=warehouseId?warehouses.find(w=>w.id===warehouseId):warehouses[0];
      if(!selected)return {...base,blockedReason:'Choose an active warehouse belonging to this seller and store.',warehouses,candidates:[]};
      const source=available(await dao.stock({tenantId,warehouseId:selected.id,offerId:c.offerId,connection}));
      if(source.greaterThanOrEqualTo(c.quantity))return {...base,blockedReason:'The original item has enough usable stock in this warehouse. A shortage substitution is not needed.',warehouses,warehouseId:selected.id,candidates:[]};
      const rows=await dao.candidates({tenantId,storeId:c.storeId,merchantId:c.merchantId,variantId:c.variantId,connection}),candidates=[];
      for(const r of rows){const entry={...await choice(tenantId,c,r,selected.id,connection)};delete entry.offer;candidates.push(entry);}
      return {...base,blockedReason:null,warehouses,warehouseId:selected.id,candidates};
    });
  }
  async function apply(tenantId,orderId,itemId,input,context) {
    const hash=createHash('sha256').update(JSON.stringify({orderId,itemId,...input})).digest('hex');
    return transaction(tenantId,async connection=>{
      const c=await load(tenantId,orderId,itemId,connection);
      const prior=await dao.receipt({tenantId,requestKey:input.requestKey,connection});
      if(prior){if(prior.orderId!==orderId||prior.hash!==hash)fail('SUBSTITUTION_REQUEST_CONFLICT','This request key was already used for different replacement details.');return orderDao.getOrder({tenantId,orderId,connection});}
      const reason=blocked(c);if(reason)fail('SUBSTITUTION_UNAVAILABLE',reason);
      if(c.orderVersion!==input.orderVersion)fail('ORDER_CHANGED','The order changed. Reload replacement options before continuing.');
      if(!input.suitabilityConfirmed)fail('SUBSTITUTION_SUITABILITY_REQUIRED','Review the product, pack size, ingredients and customer requirements before applying.',422);
      const approved=c.substitution_preference==='CONTACT_ME';
      if(approved&&(!input.customerApproved||input.approvalReference.length<8))fail('CUSTOMER_APPROVAL_REQUIRED','Contact the customer and record their explicit approval reference before replacing this item.',422);
      const warehouses=await dao.warehouses({tenantId,storeId:c.storeId,merchantId:c.merchantId,connection});
      if(!warehouses.some(w=>w.id===input.warehouseId))fail('SUBSTITUTION_WAREHOUSE_UNAVAILABLE','Choose an active warehouse for this seller and store.');
      const source=available(await dao.stock({tenantId,warehouseId:input.warehouseId,offerId:c.offerId,connection}));
      if(source.greaterThanOrEqualTo(c.quantity))fail('SOURCE_STOCK_AVAILABLE','The original item has enough usable stock; replacement is not needed.');
      const rules=await dao.candidates({tenantId,storeId:c.storeId,merchantId:c.merchantId,variantId:c.variantId,connection});
      const rule=rules.find(r=>r.offerId===input.offerId);
      if(!rule)fail('SUBSTITUTION_RULE_UNAVAILABLE','This replacement is not an active approved rule from the same seller and store.');
      const selected=await choice(tenantId,c,rule,input.warehouseId,connection);
      if(!selected.eligible)fail('SUBSTITUTION_NOT_ELIGIBLE',selected.reason);
      if(!new Decimal(selected.salePrice).equals(input.expectedSalePrice))fail('REPLACEMENT_PRICE_CHANGED','The replacement price changed. Reload options and review customer approval again.');
      const offer=selected.offer,quantity=new Decimal(c.quantity),lineTotal=new Decimal(selected.unitPrice).times(quantity).toDecimalPlaces(4);
      const tax=calculateIncludedTax({...offer,destinationStateCode:normalizeGstStateCode(c.address.stateCode)},quantity,lineTotal);
      if(tax.taxableAmount.isNegative())fail('SUBSTITUTION_TAX_INVALID','The replacement tax configuration exceeds its price. Correct the tax setup first.');
      const listTotal=new Decimal(offer.listPrice).times(quantity),discountTotal=listTotal.minus(lineTotal);
      const original={productName:c.product_name,variantName:c.variant_name,sku:c.sku,offerId:c.offerId,variantId:c.variantId,
        quantity:Number(c.quantity),unitPrice:Number(c.unit_price),lineTotal:Number(c.line_total),listPrice:Number(c.list_price),
        discountTotal:Number(c.discount_total),hsnSacCode:c.hsn_sac_code,estimatedWeight:c.estimated_weight===null?null:Number(c.estimated_weight),
        tax:{taxableAmount:Number(c.taxable_amount),cgstRate:Number(c.cgst_rate),cgstAmount:Number(c.cgst_amount),
          sgstRate:Number(c.sgst_rate),sgstAmount:Number(c.sgst_amount),igstRate:Number(c.igst_rate),igstAmount:Number(c.igst_amount),
          cessRate:Number(c.cess_rate),cessAmount:Number(c.cess_amount),taxTotal:Number(c.tax_total)},productSnapshot:c.product};
      const replacement={productName:offer.productName,variantName:offer.variantName,sku:offer.sku,offerId:offer.id,
        variantId:offer.variantId,quantity:Number(c.quantity),unitPrice:selected.unitPrice,lineTotal:lineTotal.toNumber()};
      const substitutionId=createId(),consentBasis=approved?'CUSTOMER_APPROVED':'ALLOW_SIMILAR';
      const snapshot={...c.product,imageUrl:offer.imageUrl,vertical:'GROCERY',productKind:'STANDARD',promotion:null,
        substitution:{id:substitutionId,original,replacement,consentBasis,at:new Date().toISOString()},
        tax:{pricesIncludeTax:true,taxCategoryId:offer.taxCategoryId,taxRateId:offer.taxRateId,hsnSacCode:offer.hsnSacCode,
          sellerGstin:offer.registrationGstin,originStateCode:normalizeGstStateCode(offer.registrationStateCode),
          destinationStateCode:normalizeGstStateCode(c.address.stateCode),supplyType:tax.intraState?'INTRA_STATE':'INTER_STATE'}};
      const line={...replacement,hsnSacCode:offer.hsnSacCode,unitPrice:new Decimal(selected.unitPrice).toFixed(4),listPrice:new Decimal(offer.listPrice).toFixed(4),
        lineTotal:lineTotal.toFixed(4),discountTotal:discountTotal.toFixed(4),productSnapshot:snapshot};
      for(const key of ['taxableAmount','cgstRate','cgstAmount','sgstRate','sgstAmount','igstRate','igstAmount','cessRate','cessAmount','taxTotal'])line[key]=tax[key].toFixed(key.endsWith('Rate')?6:4);
      const replacementRecord={...replacement,listPrice:Number(line.listPrice),discountTotal:Number(line.discountTotal),
        hsnSacCode:line.hsnSacCode,tax:Object.fromEntries(['taxableAmount','cgstRate','cgstAmount','sgstRate','sgstAmount','igstRate','igstAmount','cessRate','cessAmount','taxTotal'].map(key=>[key,Number(line[key])])),
        currentOfferUnitPrice:selected.salePrice,merchantAbsorbsIncrease:selected.merchantAbsorbsIncrease,
        rule:{id:rule.ruleId,priority:rule.priority,maximumPriceDifferencePercent:rule.maximumPriceDifferencePercent}};
      await dao.updateLine({tenantId,itemId,line,connection});
      await dao.updateTotals({tenantId,orderId,sellerOrderId:c.sellerOrderId,delta:{subtotal:listTotal.minus(new Decimal(c.list_price).times(quantity)).toFixed(4),
        discount:discountTotal.minus(c.discount_total).toFixed(4),tax:tax.taxTotal.minus(c.tax_total).toFixed(4),total:lineTotal.minus(c.line_total).toFixed(4)},connection});
      await dao.insertReceipt({record:{id:substitutionId,tenantId,orderId,itemId,ruleId:rule.ruleId,warehouseId:input.warehouseId,
        requestKey:input.requestKey,hash,original,replacement:replacementRecord,consentBasis,approvalReference:approved?input.approvalReference:'',reason:input.reason,actorUserId:context.actorUserId},connection});
      await orderDao.insertStatusHistory({entry:{id:createId(),tenantId,orderId,type:'ORDER',previousStatus:c.order_status,newStatus:c.order_status,
        reasonCode:'GROCERY_SUBSTITUTION',notes:`${c.product_name} replaced with ${offer.productName}; customer bill not increased.`,actorUserId:context.actorUserId},connection});
      await orderDao.insertAudit({audit:{id:createId(),tenantId,actorUserId:context.actorUserId,action:'ORDER_ITEM_SUBSTITUTED',orderId,
        requestId:context.requestId,ipAddress:context.ipAddress||'127.0.0.1',userAgent:context.userAgent||null,beforeData:original,
        afterData:{...replacementRecord,substitutionId,ruleId:rule.ruleId,consentBasis,approvalReference:approved?input.approvalReference:null,reason:input.reason}},connection});
      await orderDao.insertOutbox({event:{id:createId(),tenantId,orderId,type:'order.item.substituted',payload:{orderId,itemId,substitutionId}},connection});
      await dao.notify({tenantId,orderId,key:substitutionId,connection});
      return orderDao.getOrder({tenantId,orderId,connection});
    });
  }
  return {options,apply};
}
export const {options,apply}=createOrderSubstitutionsService();
