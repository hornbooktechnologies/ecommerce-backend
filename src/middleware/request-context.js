import { randomUUID } from "node:crypto";

export function requestContext(req, res, next) {
  const requestId = req.get("x-request-id") || randomUUID();

  req.context = Object.freeze({
    requestId,
    startedAt: new Date().toISOString()
  });

  res.setHeader("x-request-id", requestId);
  next();
}
