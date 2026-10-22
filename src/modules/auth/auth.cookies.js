import { env } from "../../config/env.js";

export const refreshCookieName = "commerce_refresh";
export const refreshTokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;

export function refreshCookieOptions() {
  return {
    httpOnly: true,
    maxAge: refreshTokenLifetimeMs,
    path: "/api/admin/v1/auth",
    sameSite: "lax",
    secure: env.nodeEnv === "production"
  };
}

export function clearRefreshCookieOptions() {
  const options = refreshCookieOptions();
  return {
    httpOnly: options.httpOnly,
    path: options.path,
    sameSite: options.sameSite,
    secure: options.secure
  };
}

export function readCookie(req, name) {
  const header = req.get("cookie");
  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = part.slice(0, separator).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }

  return null;
}
