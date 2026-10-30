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
      "req.headers[\"x-cart-token\"]",
      "req.headers[\"x-wishlist-token\"]",
      "password",
      "passwordHash",
      "refreshToken",
      "accessToken",
      "accountNumber"
      ,"keySecret", "secret_encrypted", "secret", "req.body.keySecret",
      "webhookSecret", "webhookEncrypted", "req.body.webhookSecret", "req.headers[\"x-razorpay-signature\"]"
    ],
    censor: "[REDACTED]"
  }
});
