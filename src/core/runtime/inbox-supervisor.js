import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
const workerFile = fileURLToPath(
  new URL("../../workers/inbox.js", import.meta.url),
);
const backendRoot = fileURLToPath(new URL("../../../", import.meta.url));
// Owns only its direct inbox child. Never starts email/payment/shipping workers.
export function createInboxSupervisor({
  logger,
  spawnWorker = () =>
    fork(workerFile, [], {
      cwd: backendRoot,
      execArgv: [],
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    }),
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  stallMs = 180000,
  stopMs = 10000,
} = {}) {
  let child = null,
    retry = null,
    watchdog = null,
    stopping = false,
    started = false,
    attempt = 0,
    lastProgress = 0,
    launchedAt = 0,
    stopFlight = null;
  const log = (level, details, message) => logger?.[level]?.(details, message);
  function schedule(delay) {
    clearTimer(retry);
    if (!stopping) retry = setTimer(launch, delay);
  }
  function monitor() {
    clearTimer(watchdog);
    if (!child || stopping) return;
    if (now() - lastProgress >= stallMs) {
      log(
        "error",
        { pid: child.pid, stalledMs: now() - lastProgress },
        "Inbox child made no completed-cycle progress; restarting only this child.",
      );
      void terminate(child);
      return;
    }
    watchdog = setTimer(monitor, Math.min(15000, stallMs));
  }
  function terminate(target) {
    return new Promise((resolve) => {
      if (target.exitCode !== null || target.signalCode) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimer(timer);
        clearTimer(fallback);
        resolve();
      };
      let fallback;
      const timer = setTimer(() => {
        log(
          "warn",
          { pid: target.pid },
          "Inbox shutdown timeout; terminating owned child.",
        );
        target.kill("SIGTERM");
        if(!done)fallback = setTimer(finish, 2000);
      }, stopMs);
      target.once("exit", finish);
      try {
        if (target.connected) target.send({ type: "inbox.shutdown" }, () => {});
        else target.kill("SIGTERM");
      } catch {
        target.kill("SIGTERM");
      }
    });
  }
  function launch() {
    retry = null;
    if (stopping || child) return;
    launchedAt = lastProgress = now();
    let target;
    try {
      target = spawnWorker();
    } catch (error) {
      log(
        "error",
        { code: error.code || "SPAWN_FAILED" },
        "Inbox child could not start.",
      );
      attempt++;
      schedule(Math.min(60000, 2000 * 2 ** Math.min(attempt - 1, 5)));
      return;
    }
    child = target;
    log("info", { pid: target.pid }, "Supervising in-app inbox worker.");
    let ended = false;
    const onEnd = (code, signal) => {
      if (ended) return;
      ended = true;
      clearTimer(watchdog);
      if (child === target) child = null;
      if (stopping) return;
      if (now() - launchedAt >= 60000) attempt = 0;
      const delay =
        code === 75
          ? 30000
          : Math.min(60000, 2000 * 2 ** Math.min(attempt++, 5));
      log(
        code === 75 ? "info" : "warn",
        { code, signal, retryMs: delay },
        code === 75
          ? "Another continuous inbox worker owns the database lease; waiting."
          : "Inbox child exited; scheduling restart.",
      );
      schedule(delay);
    };
    target.on("message", (message) => {
      if (message?.type === "inbox.cycle") {
        lastProgress = now();
        if (message.outcome === "FAILED")
          log(
            "warn",
            { pid: target.pid },
            "Inbox cycle reported failure; inspect worker logs and queue health.",
          );
      }
    });
    target.once("exit", onEnd);
    target.once("error", (error) => {
      log(
        "error",
        { code: error.code || "CHILD_ERROR" },
        "Inbox child process error.",
      );
      if(!target.pid)onEnd(1,null);
      else void terminate(target);
    });
    watchdog = setTimer(monitor, Math.min(15000, stallMs));
  }
  return {
    start() {
      if (started) return;
      started = true;
      launch();
    },
    stop() {
      if (stopFlight) return stopFlight;
      stopping = true;
      clearTimer(retry);
      clearTimer(watchdog);
      stopFlight = child ? terminate(child) : Promise.resolve();
      return stopFlight;
    },
    snapshot() {
      return {
        running: Boolean(child),
        pid: child?.pid || null,
        restarting: Boolean(retry),
        stopping,
      };
    },
  };
}
