import { withTransaction } from "../../database/transaction.js";
import { getPrimaryPool } from "../../database/pool-factory.js";
import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { hashPassword, verifyPassword } from "../../core/security/password.js";
import {
  createAccessToken,
  createPasswordResetToken,
  createRefreshToken,
  hashPasswordResetToken,
  hashRefreshToken
} from "../../core/security/tokens.js";
import { env } from "../../config/env.js";
import { refreshTokenLifetimeMs } from "./auth.cookies.js";
import * as authDao from "./auth.dao.js";
import { buildUiConfiguration } from "./ui-configuration.js";

const dummyPasswordHash = [
  "scrypt",
  "16384",
  "8",
  "1",
  Buffer.alloc(16).toString("base64url"),
  Buffer.alloc(64).toString("base64url")
].join(":");

function authenticationError() {
  return new AppError({
    code: "INVALID_CREDENTIALS",
    message: "The email address or password is incorrect.",
    status: 401
  });
}

function assertUserCanSignIn(user) {
  if (user.status !== "ACTIVE") {
    throw new AppError({
      code: "ACCOUNT_UNAVAILABLE",
      message: "This account is not available. Contact an administrator.",
      status: 403
    });
  }

  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    throw new AppError({
      code: "ACCOUNT_TEMPORARILY_LOCKED",
      message: "Too many unsuccessful attempts. Try again later.",
      status: 423
    });
  }
}

function areasFor(assignments) {
  const areas = new Set();
  for (const assignment of assignments) {
    if (assignment.roleLevel === "PLATFORM") {
      areas.add("platform");
    } else if (assignment.roleLevel === "VENDOR") {
      areas.add("vendor");
    } else {
      areas.add("admin");
    }
  }
  return [...areas];
}

function publicUser(user, assignments) {
  const areas = areasFor(assignments);
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    displayName: [user.firstName, user.lastName].filter(Boolean).join(" "),
    areas,
    defaultArea: areas[0] || "admin",
    assignments,
    ui: buildUiConfiguration(assignments)
  };
}

function sessionInput({ userId, refreshToken, deviceName, ipAddress, userAgent }) {
  return {
    id: createId(),
    userId,
    refreshTokenHash: hashRefreshToken(refreshToken),
    deviceName: deviceName || null,
    ipAddress: ipAddress || null,
    userAgent: userAgent?.slice(0, 500) || null,
    expiresAt: new Date(Date.now() + refreshTokenLifetimeMs)
  };
}

export async function login({ email, password, deviceName, ipAddress, userAgent }) {
  return withTransaction(null, async (connection) => {
    const user = await authDao.findUserByEmail({
      email: email.trim().toLowerCase(),
      connection,
      forUpdate: true
    });
    const passwordMatches = await verifyPassword(password, user?.passwordHash || dummyPasswordHash);

    if (!user || !passwordMatches) {
      if (user) {
        await authDao.recordFailedLogin({ userId: user.id, connection });
      }
      throw authenticationError();
    }

    assertUserCanSignIn(user);
    await authDao.recordSuccessfulLogin({ userId: user.id, connection });

    const refreshToken = createRefreshToken();
    const session = sessionInput({ userId: user.id, refreshToken, deviceName, ipAddress, userAgent });
    await authDao.insertSession({ session, connection });
    const assignments = await authDao.listRoleAssignments({ userId: user.id, connection });

    return {
      accessToken: createAccessToken({ userId: user.id, sessionId: session.id }),
      refreshToken,
      user: publicUser(user, assignments)
    };
  });
}

export async function refresh({ refreshToken, deviceName, ipAddress, userAgent }) {
  if (!refreshToken) {
    throw new AppError({ code: "AUTHENTICATION_REQUIRED", message: "Please sign in.", status: 401 });
  }

  return withTransaction(null, async (connection) => {
    const current = await authDao.findSessionForUpdate({
      refreshTokenHash: hashRefreshToken(refreshToken),
      connection
    });

    if (!current || current.revokedAt || new Date(current.expiresAt) <= new Date()) {
      throw new AppError({
        code: "SESSION_EXPIRED",
        message: "Your session has expired. Please sign in again.",
        status: 401
      });
    }

    assertUserCanSignIn(current.user);
    const revoked = await authDao.revokeSession({ sessionId: current.id, connection });
    if (!revoked) {
      throw new AppError({ code: "SESSION_EXPIRED", message: "Your session has expired.", status: 401 });
    }

    const nextRefreshToken = createRefreshToken();
    const nextSession = sessionInput({
      userId: current.userId,
      refreshToken: nextRefreshToken,
      deviceName,
      ipAddress,
      userAgent
    });
    await authDao.insertSession({ session: nextSession, connection });
    const assignments = await authDao.listRoleAssignments({ userId: current.userId, connection });

    return {
      accessToken: createAccessToken({ userId: current.userId, sessionId: nextSession.id }),
      refreshToken: nextRefreshToken,
      user: publicUser(current.user, assignments)
    };
  });
}

export async function logout({ refreshToken }) {
  if (refreshToken) {
    await authDao.revokeSessionByTokenHash({ refreshTokenHash: hashRefreshToken(refreshToken) });
  }
}

const resetLifetimeMs = 30 * 60 * 1000;
const resetResponseMessage = "If an active account matches that email, password reset instructions are ready.";

export async function requestPasswordReset({ email, ipAddress, userAgent }) {
  let developmentResetToken = null;
  await withTransaction(null, async (connection) => {
    const user = await authDao.findUserByEmail({ email: email.trim().toLowerCase(), connection,
      forUpdate: true });
    if (!user || user.status !== "ACTIVE") return;
    if (await authDao.countRecentPasswordResetRequests({ userId: user.id, connection }) >= 3) return;
    await authDao.invalidatePasswordResetTokens({ userId: user.id, connection });
    const token = createPasswordResetToken();
    await authDao.insertPasswordResetToken({ reset: { id: createId(), userId: user.id,
      tokenHash: hashPasswordResetToken(token), ipAddress, userAgent: userAgent?.slice(0, 500) || null,
      expiresAt: new Date(Date.now() + resetLifetimeMs) }, connection });
    if (env.nodeEnv === "development") developmentResetToken = token;
  });
  return { message: resetResponseMessage, expiresInMinutes: 30,
    ...(developmentResetToken ? { developmentResetUrl:
      `${env.adminAppUrl}/reset-password?token=${encodeURIComponent(developmentResetToken)}` } : {}) };
}

function invalidResetToken() {
  return new AppError({ code: "PASSWORD_RESET_TOKEN_INVALID",
    message: "This password reset link is invalid or has expired. Request a new link.", status: 400 });
}

export async function resetPassword({ token, newPassword }) {
  await withTransaction(null, async (connection) => {
    const reset = await authDao.findPasswordResetTokenForUpdate({
      tokenHash: hashPasswordResetToken(token), connection });
    if (!reset || reset.usedAt || new Date(reset.expiresAt) <= new Date()
      || reset.user.status !== "ACTIVE") throw invalidResetToken();
    if (await verifyPassword(newPassword, reset.user.passwordHash)) {
      throw new AppError({ code: "PASSWORD_REUSE_NOT_ALLOWED",
        message: "Choose a password different from your current password.", status: 422,
        details: [{ field: "newPassword", code: "password_reuse", message: "Choose a new password." }] });
    }
    await authDao.updatePassword({ userId: reset.userId,
      passwordHash: await hashPassword(newPassword), connection });
    await authDao.markPasswordResetTokenUsed({ resetId: reset.id, connection });
    await authDao.invalidatePasswordResetTokens({ userId: reset.userId,
      exceptId: reset.id, connection });
    await authDao.revokeUserSessions({ userId: reset.userId, connection });
  });
}

export async function changePassword({ userId, currentPassword, newPassword }) {
  await withTransaction(null, async (connection) => {
    const user = await authDao.findUserByIdForUpdate({ userId, connection });
    if (!user || user.status !== "ACTIVE") {
      throw new AppError({ code: "AUTHENTICATION_REQUIRED", message: "Please sign in again.", status: 401 });
    }
    if (!await verifyPassword(currentPassword, user.passwordHash)) {
      throw new AppError({ code: "CURRENT_PASSWORD_INCORRECT",
        message: "The current password is incorrect.", status: 422,
        details: [{ field: "currentPassword", code: "password_incorrect",
          message: "Enter your current password." }] });
    }
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw new AppError({ code: "PASSWORD_REUSE_NOT_ALLOWED",
        message: "Choose a password different from your current password.", status: 422,
        details: [{ field: "newPassword", code: "password_reuse", message: "Choose a new password." }] });
    }
    await authDao.updatePassword({ userId, passwordHash: await hashPassword(newPassword), connection });
    await authDao.invalidatePasswordResetTokens({ userId, connection });
    await authDao.revokeUserSessions({ userId, connection });
  });
}

export async function getCurrentUser({ userId }) {
  const [user, assignments] = await Promise.all([
    authDao.findUserById({ userId, connection: getPrimaryPool() }),
    authDao.listRoleAssignments({ userId, connection: getPrimaryPool() })
  ]);

  if (!user) {
    throw new AppError({ code: "AUTHENTICATION_REQUIRED", message: "Please sign in.", status: 401 });
  }
  assertUserCanSignIn(user);
  return publicUser(user, assignments);
}
