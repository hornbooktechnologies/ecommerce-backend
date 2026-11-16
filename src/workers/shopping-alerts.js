import {logger} from '../config/logger.js';
import {setTimeout as pause} from 'node:timers/promises';
import {createShoppingMonitor} from '../modules/shopping/shopping.service.js';
import {pruneHistory} from '../modules/shopping/shopping.dao.js';
import {closePrimaryPool} from '../database/pool-factory.js';
const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
try{const monitor=createShoppingMonitor(),once=process.argv.includes('--once');do{let result;try{const expiredHistoryRemoved=await pruneHistory();result=await monitor.once();logger.info(JSON.stringify({...result,expiredHistoryRemoved}));if(once&&result.failed)process.exitCode=1;}catch{logger.error('Shopping alert scan failed; check database access and migration 047.');if(once)process.exitCode=1;}if(!once&&!controller.signal.aborted)await pause(result?.cycleComplete===false?1000:30000,undefined,{signal:controller.signal}).catch(()=>{});if(once)break;}while(!controller.signal.aborted);}finally{await closePrimaryPool();}
