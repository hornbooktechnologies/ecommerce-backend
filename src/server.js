import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { closePrimaryPool } from "./database/pool-factory.js";

const app = createApp();
const server = createServer(app);

server.listen(env.port, () => {
  logger.info({ port: env.port, environment: env.nodeEnv }, "API server listening");
});

async function shutdown(signal) {
  logger.info({ signal }, "Graceful shutdown started");

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
