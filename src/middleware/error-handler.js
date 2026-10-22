import { AppError } from "../core/errors/app-error.js";

export function errorHandler(error, req, res, _next) {
  const appError = error?.type === "entity.too.large"
    ? new AppError({ code: "PRODUCT_IMAGE_TOO_LARGE", message: "Product images must be 8 MB or smaller.", status: 413 })
    : error instanceof AppError
    ? error
    : new AppError({
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
        status: 500
      });

  if (appError.status >= 500) {
    req.log?.error({ error }, "Unhandled request error");
  }

  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      details: appError.details,
      requestId: req.context?.requestId
    }
  });
}
