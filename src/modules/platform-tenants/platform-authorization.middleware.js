import { AppError } from "../../core/errors/app-error.js";
import * as platformAccessDao from "../platform-access/platform-access.dao.js";

function denied() {
  return new AppError({
    code: "FORBIDDEN",
    message: "You do not have access to platform administration.",
    status: 403
  });
}

export async function authorizePlatform(req, _res, next) {
  const access = await platformAccessDao.findPlatformAccess({ userId: req.context.actor.userId });
  if (!access) return next(denied());
  next();
}

export function requirePlatformPermission(permission) {
  return async (req, _res, next) => {
    const access = await platformAccessDao.findPlatformAccess({ userId: req.context.actor.userId });
    if (!access || (!access.unrestricted && !access.permissions.includes(permission))) {
      return next(denied());
    }
    req.context = Object.freeze({ ...req.context, platform: Object.freeze(access) });
    next();
  };
}
