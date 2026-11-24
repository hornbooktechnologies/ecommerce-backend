import assert from 'node:assert/strict';
import test from 'node:test';
import {productReadiness,offerReadiness} from '../src/modules/catalog/catalog.service.js';

const offer={sku:'BLUE-M',offerId:'a',activeOffer:true,activeVariant:true,price:400,available:2,minimum:2,maximum:null};
test('readiness is for this SKU and offer, not aggregate product stock',()=>{
  for(const [patch,published,expected] of [
    [{},true,'READY'],[{available:1},true,'STOCK'],[{available:0},true,'STOCK'],
    [{price:null},true,'NO_PRICE'],[{offerId:null},true,'NO_OFFER'],[{activeOffer:false},true,'INACTIVE_OFFER'],
    [{activeVariant:false},true,'INACTIVE_SKU'],[{available:null},true,'NOT_ELIGIBLE'],
    [{maximum:1},true,'ORDER_LIMIT'],[{},false,'NOT_PUBLISHED']
  ]) assert.equal(offerReadiness({...offer,...patch},published),expected);
});
const product={approvalStatus:'APPROVED',publicationStatus:'PUBLISHED'};
const source={
  findProductDetail:async()=>product,
  readinessStores:async()=>[{id:'s',name:'Main',currency:'INR'}],
  readinessRows:async({scope,productId})=>{
    assert.deepEqual(scope,{tenantId:'t',storeId:'s',currency:'INR'});assert.equal(productId,'p');
    return [offer,{...offer,offerId:'b',available:0}];
  }
};
test('keeps two sellers of one SKU separate and rejects a foreign store', async()=>{
  const result=await productReadiness('t','p',undefined,source);
  assert.deepEqual(result.rows.map(row=>row.status),['READY','STOCK']);
  await assert.rejects(productReadiness('t','p','foreign',source),/active store/);
});
test('no active stores or absent tenant product do not trigger an offer lookup',async()=>{
  const empty={...source,readinessStores:async()=>[],readinessRows:()=>assert.fail()};
  assert.deepEqual((await productReadiness('t','p',null,empty)).rows,[]);
  await assert.rejects(productReadiness('t','p',null,{...empty,findProductDetail:async()=>null}),/product could not be found/i);
});
