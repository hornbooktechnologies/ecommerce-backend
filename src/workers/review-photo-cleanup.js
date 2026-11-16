import {logger} from '../config/logger.js';
import {cleanupOnce} from '../modules/review-photos/review-photos.service.js';
import {closePrimaryPool} from '../database/pool-factory.js';
try{logger.info(JSON.stringify(await cleanupOnce()));}catch(error){logger.error(JSON.stringify({code:error.code||'PHOTO_CLEANUP_FAILED'}));process.exitCode=1;}finally{await closePrimaryPool();}
