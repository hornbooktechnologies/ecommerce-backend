import {createHash} from 'node:crypto';
import {AppError} from '../../core/errors/app-error.js';
import {createId} from '../../core/identifiers/uuid.js';
import {withTransaction} from '../../database/transaction.js';
import {resolveStore,findProduct} from '../storefront/storefront.dao.js';
import * as dao from './review-photos.dao.js';
import * as storage from './review-photos.storage.js';
const fail=(code,message,status=422)=>{throw new AppError({code,message,status});};
const dto=(photo,admin=false)=>({id:photo.id,reviewId:photo.reviewId,alt:photo.alt,status:photo.status,storageState:photo.storageState,width:photo.width,height:photo.height,byteSize:photo.byteSize,version:photo.version,...(admin?{moderationNote:photo.moderationNote}:{})});
export async function own(store,account,reviewId,connection,upload=false){
 await dao.lockReview({...store,reviewId,connection});
 const args={...store,customerId:account.customerId,reviewId,connection},review=await dao.ownedReview(args);
 if(!review)fail('REVIEW_NOT_FOUND','This review is unavailable in your account or store.',404);
 if(upload&&(!review.eligible||review.deletedAt||!['PENDING','PUBLISHED'].includes(review.status)))fail('REVIEW_PHOTOS_UNAVAILABLE','Photos can only be added to your eligible delivered-item review while it is pending or published.',409);
 return args;
}
export async function preflight(store,account,reviewId,photoId,connection){const args=await own(store,account,reviewId,connection,true);const previous=await dao.find({...args,photoId});if(!previous&&(await dao.list(args)).length>=5)fail('PHOTO_LIMIT','A review can have up to five photos. Remove one before adding another.',409);return args;}
export async function listOwn(store,account,reviewId,connection){const args=await own(store,account,reviewId,connection);return {items:(await dao.list(args)).map(photo=>dto(photo)),limit:5};}
async function cleanupFile(tenantId,photoId,key){try{await storage.remove(key);await dao.fileRemoved({tenantId,photoId});return true;}catch{return false;}}
export async function upload({store,token,reviewId,photoId,buffer,mime,alt,accounts}){
 if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>storage.MAX_INPUT)fail('PHOTO_SIZE','Choose a photo of 5 MB or smaller.',413);
 const hash=createHash('sha256').update(buffer).digest();let reserved;
 const existing=await accounts.withAuthenticatedAccount(store,token,async(account,connection)=>{
  const args=await preflight(store,account,reviewId,photoId,connection),prior=await dao.find({...args,photoId,lock:true});
  if(prior){if(prior.deletedAt)fail('PHOTO_REMOVED','This upload was removed. Choose the photo again to start a new upload.',410);if(!prior.hash.equals(hash)||prior.alt!==alt)fail('PHOTO_UPLOAD_CHANGED','This upload ID belongs to different photo content. Choose the file again.',409);if(prior.storageState!=='READY')fail('PHOTO_UPLOAD_IN_PROGRESS','This upload is incomplete or still processing. Refresh the photo list; remove an incomplete upload before retrying.',409);return dto(prior);}
  if(await dao.dailyAttempts(args)>=20)fail('PHOTO_UPLOAD_LIMIT','You can attempt up to twenty review-photo uploads per day. Please try again later.',429);
  const key=`${createId().replaceAll('-','')}.webp`;
  try{await dao.insert({...args,photoId,key,hash,alt});}catch(error){if(error.code==='ER_DUP_ENTRY')fail('PHOTO_UPLOAD_CONFLICT','This upload ID is unavailable. Select the file again.',409);throw error;}
  reserved={key,customerId:account.customerId};return null;
 });
 if(existing)return {photo:existing,message:'This photo has already been uploaded.'};
 try{
  const image=await storage.processImage(buffer,mime);await storage.write(reserved.key,image.buffer);
  const photo=await accounts.withAuthenticatedAccount(store,token,async(account,connection)=>{
   if(account.customerId!==reserved.customerId)fail('REVIEW_NOT_FOUND','This review is unavailable.',404);
   const args=await own(store,account,reviewId,connection,true),current=await dao.find({...args,photoId,lock:true});
   if(!current||current.deletedAt||current.storageKey!==reserved.key)fail('PHOTO_REMOVED','This photo was removed before the upload completed.',410);
   await dao.ready({...args,photoId,image});await dao.audit({...args,photoId,action:'REVIEW_PHOTO_UPLOADED'});return dto(await dao.find({...args,photoId}));
  });return {photo,message:'Photo uploaded and awaiting moderation.'};
 }catch(error){await dao.abortStage({tenantId:store.tenantId,photoId,key:reserved.key});await cleanupFile(store.tenantId,photoId,reserved.key);throw error;}
}
export async function removeOwn(store,account,reviewId,photoId,version,connection){const args=await own(store,account,reviewId,connection),photo=await dao.find({...args,photoId,lock:true});if(!photo)fail('PHOTO_NOT_FOUND','This photo is unavailable.',404);if(!photo.deletedAt){if(photo.version!==version)fail('PHOTO_CHANGED','This photo changed. Refresh the photo list before removing it.',409);await dao.markRemoved({...args,photoId});await dao.audit({...args,photoId,action:'REVIEW_PHOTO_REMOVED'});}return {key:photo.storageKey};}
export async function finishRemoval(tenantId,photoId,key){const cleaned=await cleanupFile(tenantId,photoId,key);return {removed:true,fileCleanupPending:!cleaned,message:cleaned?'Photo removed.':'Photo is hidden; physical cleanup will be retried by the cleanup task.'};}
async function binary(photo){if(!photo||photo.deletedAt||photo.storageState!=='READY')fail('PHOTO_NOT_FOUND','This photo is unavailable.',404);try{return await storage.read(photo.storageKey);}catch(error){if(error.code==='ENOENT')fail('PHOTO_NOT_FOUND','This photo is unavailable.',404);throw error;}}
export async function ownFile(store,account,reviewId,photoId,connection){const args=await own(store,account,reviewId,connection);return binary(await dao.find({...args,photoId}));}
export async function adminList(tenantId,reviewId){const review=await import('../ratings/ratings.dao.js').then(module=>module.getRating({tenantId,ratingId:reviewId}));if(!review)fail('REVIEW_NOT_FOUND','This review is unavailable.',404);return {items:(await dao.list({tenantId,reviewId})).map(photo=>dto(photo,true))};}
export async function adminFile(tenantId,reviewId,photoId){await adminList(tenantId,reviewId);return binary(await dao.find({tenantId,reviewId,photoId}));}
export async function moderate(tenantId,reviewId,photoId,input,context){return withTransaction(tenantId,async connection=>{
 const review=await dao.lockReview({tenantId,reviewId,connection});if(!review||review.deleted_at)fail('REVIEW_NOT_FOUND','This review is unavailable.',404);
 const photo=await dao.find({tenantId,reviewId,photoId,connection,lock:true});if(!photo||photo.deletedAt)fail('PHOTO_NOT_FOUND','This photo is unavailable.',404);
 if(photo.version!==input.version)fail('PHOTO_CHANGED','This photo changed. Refresh before moderating it.',409);if(photo.storageState!=='READY')fail('PHOTO_NOT_READY','This upload has not completed.',409);
 await dao.moderate({tenantId,reviewId,photoId,...input,actorUserId:context.actorUserId,connection});await dao.audit({tenantId,reviewId,photoId,actorUserId:context.actorUserId,action:`REVIEW_PHOTO_${input.status}`,connection});return dto(await dao.find({tenantId,reviewId,photoId,connection}),true);
});}
export async function publicList(scope,reviewIds){return (await dao.publicPhotos({scope,reviewIds})).map(photo=>({id:photo.id,reviewId:photo.reviewId,alt:photo.alt,width:photo.width,height:photo.height,url:`/api/review-photos/${photo.id}`}));}
export async function publicFile(params,photoId){const scope=await resolveStore(params);if(!scope)fail('PHOTO_NOT_FOUND','This photo is unavailable.',404);const source=await dao.publicSource({...scope,photoId});if(!source||!await findProduct({scope,slug:source.slug}))fail('PHOTO_NOT_FOUND','This photo is unavailable.',404);return binary((await dao.publicPhotos({scope,reviewIds:[source.reviewId]})).find(photo=>photo.id===photoId));}
export async function cleanupOnce(){let removed=0,pending=0;for(const row of await dao.cleanupCandidates()){if(await cleanupFile(row.tenantId,row.photoId,row.storageKey))removed++;else pending++;}return {removed,pending};}
