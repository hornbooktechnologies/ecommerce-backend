import { AppError } from "../../core/errors/app-error.js";
import * as authDao from "../auth/auth.dao.js";

export async function authorizePlatform(req, _res, next) {
  const authorized = await authDao.hasActivePlatformRole({
    userId: req.context.actor.userId
  });

  if (!authorized) {
    return next(new AppError({
      code: "FORBIDDEN",
      message: "You do not have access to platform administration.",
      status: 403
    }));
  }

  next();
}
