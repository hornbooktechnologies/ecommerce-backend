import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { closePrimaryPool } from "./database/pool-factory.js";
import {createInboxSupervisor} from './core/runtime/inbox-supervisor.js';
import { startOrderLifecycleEmails } from './core/runtime/order-receipts.js';

const app = createApp();
let stopOrderEmails;
const server = createServer(app);
const inbox=process.env.INBOX_WORKER_AUTOSTART==='false'?null:createInboxSupervisor({logger});

server.listen(env.port, () => {
  logger.info({ port: env.port, environment: env.nodeEnv }, "API server listening");
  inbox?.start();
  stopOrderEmails = startOrderLifecycleEmails(logger);
});
server.once('error',async error=>{logger.error({code:error.code,port:env.port},'API could not listen; no inbox child will be started.');process.exitCode=1;await inbox?.stop();await closePrimaryPool();});

async function shutdown(signal) {
  logger.info({ signal }, "Graceful shutdown started");
  await Promise.all([inbox?.stop(), stopOrderEmails?.()]);

  server.close(async (error) => {
    if (error) {
      logger.error({ error }, "HTTP server shutdown failed");
      process.exitCode = 1;
    }

    try {
      await closePrimaryPool();
    } catch (poolError) {
      logger.error({ error: poolError }, "Database pool shutdown failed");
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
