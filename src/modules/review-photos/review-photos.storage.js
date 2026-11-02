import sharp from 'sharp';
import path from 'node:path';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {env} from '../../config/env.js';
import {AppError} from '../../core/errors/app-error.js';
export const MAX_INPUT=5*1024*1024,MAX_OUTPUT=3*1024*1024;
const root=path.resolve(env.reviewPhotoDirectory);
for(const publicDirectory of [env.productMediaDirectory,env.vendorLogoDirectory]){
 const relative=path.relative(path.resolve(publicDirectory),root);
 if(!relative||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('Review photos must be outside public media directories.');
}
const fail=(code,message,status=422)=>{throw new AppError({code,message,status});};
const filePath=key=>{if(!/^[a-f0-9]{32}\.webp$/.test(key))throw Error('Invalid review photo storage key');const target=path.resolve(root,key);if(path.dirname(target)!==root)throw Error('Invalid review photo path');return target;};
let active=0;
export async function processImage(buffer,mime){
 if(!Buffer.isBuffer(buffer)||!buffer.length)fail('PHOTO_REQUIRED','Choose a photo to upload.');
 if(buffer.length>MAX_INPUT)fail('PHOTO_TOO_LARGE','Review photos must be 5 MB or smaller.',413);
 const type=String(mime||'').split(';')[0].trim().toLowerCase(),format={'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'}[type];
 if(!format)fail('PHOTO_TYPE','Choose a JPEG, PNG or WebP photo.',415);
 if(active>=4)fail('PHOTO_PROCESSING_BUSY','Image processing is busy. Please retry shortly.',503);
 active++;
 try{
  const image=sharp(buffer,{limitInputPixels:25000000,failOn:'warning',sequentialRead:true});
  const meta=await image.metadata();
  if(meta.format!==format||(meta.pages||1)>1||!meta.width||!meta.height||meta.width<32||meta.height<32)fail('PHOTO_CONTENT','Use a single, non-animated JPEG, PNG or WebP photo at least 32 pixels wide and tall.');
  const result=await image.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).webp({quality:80}).timeout({seconds:10}).toBuffer({resolveWithObject:true});
  if(result.data.length>MAX_OUTPUT)fail('PHOTO_OUTPUT_TOO_LARGE','This photo is too complex. Choose a smaller photo.');
  // No keepMetadata/withMetadata: metadata and original container data are not retained.
  return {buffer:result.data,width:result.info.width,height:result.info.height,byteSize:result.data.length};
 }catch(error){if(error instanceof AppError)throw error;fail('PHOTO_CONTENT','The file could not be decoded safely. Use a valid, non-animated photo of at most 25 megapixels.');}
 finally{active--;}
}
export async function write(key,buffer){await mkdir(root,{recursive:true});await writeFile(filePath(key),buffer,{flag:'wx'});}
export const read=key=>readFile(filePath(key));
export async function remove(key){try{await unlink(filePath(key));}catch(error){if(error.code!=='ENOENT')throw error;}}
