import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

function authenticationService(overrides = {}) {
  return {
    async login({ email }) {
      return {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        user: {
          id: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77",
          email,
          firstName: "Platform",
          lastName: "Admin",
          displayName: "Platform Admin",
          areas: ["platform"],
          defaultArea: "platform",
          assignments: []
        }
      };
    },
    async refresh() {},
    async logout() {},
    async getCurrentUser() {},
    async requestPasswordReset() { return { message: "If an active account matches that email, password reset instructions are ready.", expiresInMinutes: 30 }; },
    async resetPassword() {},
    async changePassword() {},
    ...overrides
  };
}

test("POST /auth/login returns an access token and HTTP-only refresh cookie", async () => {
  const response = await request(createApp({ authenticationService: authenticationService() }))
    .post("/api/admin/v1/auth/login")
    .send({ email: "admin@example.com", password: "correct-horse-battery-staple" });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.accessToken, "test-access-token");
  assert.equal(response.body.data.user.defaultArea, "platform");
  assert.match(response.headers["set-cookie"][0], /commerce_refresh=test-refresh-token/);
  assert.match(response.headers["set-cookie"][0], /HttpOnly/);
});

test("POST /auth/login returns field-level validation errors", async () => {
  const response = await request(createApp({ authenticationService: authenticationService() }))
    .post("/api/admin/v1/auth/login")
    .send({ email: "invalid", password: "short" });

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
  assert.ok(response.body.error.details.some((detail) => detail.field === "email"));
  assert.ok(response.body.error.details.some((detail) => detail.field === "password"));
});

test("POST /auth/password/forgot returns the same accepted response", async () => {
  let receivedEmail;
  const response = await request(createApp({ authenticationService: authenticationService({
    async requestPasswordReset({ email }) {
      receivedEmail = email;
      return { message: "If an active account matches that email, password reset instructions are ready.",
        expiresInMinutes: 30 };
    }
  }) })).post("/api/admin/v1/auth/password/forgot").send({ email: "member@example.com" });
  assert.equal(response.status, 202);
  assert.equal(receivedEmail, "member@example.com");
  assert.equal(response.body.data.expiresInMinutes, 30);
});

test("POST /auth/password/reset validates and consumes a reset token", async () => {
  let received;
  const response = await request(createApp({ authenticationService: authenticationService({
    async resetPassword(input) { received = input; }
  }) })).post("/api/admin/v1/auth/password/reset").send({
    token: "a".repeat(43), newPassword: "new-secure-password-2026"
  });
  assert.equal(response.status, 204);
  assert.equal(received.newPassword, "new-secure-password-2026");
});

test("PATCH /auth/password requires authentication and forwards the current user", async () => {
  let received;
  const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
  const token = createAccessToken({ userId,
    sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b78" });
  const response = await request(createApp({ authenticationService: authenticationService({
    async changePassword(input) { received = input; }
  }) })).patch("/api/admin/v1/auth/password")
    .set("authorization", `Bearer ${token}`)
    .send({ currentPassword: "current-password-2026", newPassword: "new-password-value-2026" });
  assert.equal(response.status, 204);
  assert.equal(received.userId, userId);
  assert.equal(received.currentPassword, "current-password-2026");
});

test("password endpoints reject weak password input", async () => {
  const response = await request(createApp({ authenticationService: authenticationService() }))
    .post("/api/admin/v1/auth/password/reset")
    .send({ token: "a".repeat(43), newPassword: "short" });
  assert.equal(response.status, 422);
  assert.ok(response.body.error.details.some((detail) => detail.field === "newPassword"));
});
