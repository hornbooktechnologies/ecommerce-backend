import { AppError } from "../core/errors/app-error.js";

export function errorHandler(error, req, res, _next) {
  const uploadLimit = req.originalUrl?.includes("/documents")
    ? { code: "VENDOR_DOCUMENT_TOO_LARGE", message: "Vendor documents must be 10 MB or smaller." }
    : req.originalUrl?.includes("/vendors/") && req.originalUrl?.includes("/logo")
      ? { code: "VENDOR_LOGO_TOO_LARGE", message: "Vendor logos must be 2 MB or smaller." }
      : { code: "PRODUCT_IMAGE_TOO_LARGE", message: "Product images must be 8 MB or smaller." };
  const appError = error?.type === "entity.too.large"
    ? new AppError({ ...uploadLimit, status: 413 })
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
