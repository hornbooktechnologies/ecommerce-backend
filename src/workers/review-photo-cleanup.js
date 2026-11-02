import {cleanupOnce} from '../modules/review-photos/review-photos.service.js';
import {closePrimaryPool} from '../database/pool-factory.js';
try{console.log(JSON.stringify(await cleanupOnce()));}catch(error){console.error(JSON.stringify({code:error.code||'PHOTO_CLEANUP_FAILED'}));process.exitCode=1;}finally{await closePrimaryPool();}
