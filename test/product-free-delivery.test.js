import test from "node:test";
import assert from "node:assert/strict";
import {qualifiesForFreeDelivery as free} from "../src/modules/storefront/free-delivery.js";
import {deliveryPolicySchema} from "../src/modules/store-operations/store-operations.validators.js";
import {createOrdersService} from "../src/modules/orders/orders.service.js";
test("order review charges the existing zone fee only for nonqualifying baskets and still enforces coverage",async()=>{
  async function preview(flags,zone={deliveryDays:2,deliveryFee:40}){
    const offers=flags.map((flag,i)=>({id:String(i),merchantId:"seller",freeDelivery:flag,hsnSacCode:"1234",
      taxCategoryId:"tc",taxRateId:"tr",registrationGstin:"29ABCDE1234F1Z5",registrationStateCode:"29",
      cgstRate:0,sgstRate:0,igstRate:0,cessRate:0,cessAmount:0,
      minimumOrderQuantity:1,quantityStep:1,maximumOrderQuantity:null,estimatedWeight:null,
      listPrice:600,salePrice:500,availableQuantity:10}));
    const engine=createOrdersService({transaction:async(_,work)=>work({}),resolveZone:async()=>zone,
      dao:{findStoreContext:async()=>({id:"store",currency:"INR"}),findOffersForOrder:async()=>offers,findCustomer:async()=>({id:"customer"})}});
    return engine.createOrder("tenant",{storeId:"store",items:offers.map(o=>({offerId:o.id,quantity:1})),
      customer:{},shippingAddress:{stateCode:"KA",postalCode:"560001"}},{preview:true});
  }
  assert.equal((await preview([true,true])).shippingTotal,"0.0000");
  assert.equal((await preview([true,false])).shippingTotal,"40.0000");
  assert.equal((await preview([false],{deliveryDays:2,deliveryFee:40,freeDeliveryThreshold:500})).shippingTotal,"0.0000");
  await assert.rejects(preview([true],null),{code:"DELIVERY_UNSUPPORTED"});
});
test("free delivery uses the selected unit price, independent of PIN and quantity",()=>{
  const offer={free_delivery:0,free_delivery_above_inr:"500.00",sale_price:"500.00",list_price:800,quantity:3};
  assert.equal(free(offer),false);
  assert.equal(free({...offer,sale_price:"500.01"}),true);
  assert.equal(free({...offer,sale_price:"499.99"}),false);
  assert.equal(free({...offer,free_delivery_above_inr:null}),false);
  assert.equal(free({...offer,free_delivery:1,free_delivery_above_inr:null,sale_price:20}),true);
});
test("tenant threshold accepts explicit disable and rejects missing or negative values",()=>{
  for(const aboveInr of [null,0,500]) assert.equal(deliveryPolicySchema.validate({aboveInr}).error,undefined);
  for(const invalid of [{},{aboveInr:-1}]) assert.ok(deliveryPolicySchema.validate(invalid).error);
});
