import { AppError } from "../core/errors/app-error.js";

export function notFound(req, _res, next) {
  next(new AppError({
    code: "ROUTE_NOT_FOUND",
    message: `No route matches ${req.method} ${req.originalUrl}.`,
    status: 404
  }));
}
