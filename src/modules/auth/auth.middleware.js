import { verifyAccessToken } from "../../core/security/tokens.js";
import { AppError } from "../../core/errors/app-error.js";

export function authenticate(req, _res, next) {
  const authorization = req.get("authorization") || "";
  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next(new AppError({
      code: "AUTHENTICATION_REQUIRED",
      message: "Please sign in to continue.",
      status: 401
    }));
  }

  const identity = verifyAccessToken(token);
  req.context = Object.freeze({
    ...req.context,
    actor: Object.freeze({
      userId: identity.userId,
      sessionId: identity.sessionId,
      actorType: "USER"
    })
  });

  next();
}
