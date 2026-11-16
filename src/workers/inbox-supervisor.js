import { createInboxSupervisor } from "../core/runtime/inbox-supervisor.js";
import { logger } from "../config/logger.js";
const supervisor = createInboxSupervisor({ logger });
supervisor.start();
const stop = () => {
  void supervisor.stop().catch(() => {
    process.exitCode = 1;
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
