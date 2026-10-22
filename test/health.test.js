import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";

test("GET /health/live reports the service as alive", async () => {
  const response = await request(createApp()).get("/health/live");

  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, "ok");
  assert.equal(response.body.data.service, "ecommerce-api");
  assert.ok(response.headers["x-request-id"]);
});

test("GET /health/ready returns 503 when a dependency is down", async () => {
  const app = createApp({
    readinessCheck: async () => ({ database: { status: "down" } })
  });
  const response = await request(app).get("/health/ready");

  assert.equal(response.status, 503);
  assert.equal(response.body.data.status, "not-ready");
});

test("unknown routes use the public error envelope", async () => {
  const response = await request(createApp()).get("/missing");

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "ROUTE_NOT_FOUND");
  assert.ok(response.body.error.requestId);
});
