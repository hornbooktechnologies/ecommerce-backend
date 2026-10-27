import { createHmac, randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { AppError } from "../errors/app-error.js";

const issuer = "commerce-os-api";
const audience = "commerce-os-admin";

export function createAccessToken({ userId, sessionId }) {
  return jwt.sign(
    { sid: sessionId, type: "access" },
    env.accessTokenSecret,
    {
      algorithm: "HS256",
      audience,
      expiresIn: "1h",
      issuer,
      jwtid: randomUUID(),
      subject: userId
    }
  );
}

export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, env.accessTokenSecret, {
      algorithms: ["HS256"],
      audience,
      issuer
    });

    if (payload.type !== "access" || !payload.sub || !payload.sid) {
      throw new Error("Invalid access-token payload.");
    }

    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    throw new AppError({
      code: "AUTHENTICATION_REQUIRED",
      message: "Your session is invalid or has expired.",
      status: 401
    });
  }
}

export function createRefreshToken() {
  return randomBytes(48).toString("base64url");
}

export function hashRefreshToken(token) {
  return createHmac("sha256", env.refreshTokenSecret).update(token).digest();
}

export function createPasswordResetToken() {
  return randomBytes(32).toString("base64url");
}

export function hashPasswordResetToken(token) {
  return createHmac("sha256", env.passwordResetSecret).update(token).digest();
}
