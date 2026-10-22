import pino from "pino";
import { env } from "./env.js";

const transport = env.nodeEnv === "development"
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname"
      }
    }
  : undefined;

export const logger = pino({
  level: env.logLevel,
  transport,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "passwordHash",
      "refreshToken",
      "accessToken",
      "accountNumber"
    ],
    censor: "[REDACTED]"
  }
});
