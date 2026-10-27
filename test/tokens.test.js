import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { createAccessToken, createPasswordResetToken, createRefreshToken,
  hashPasswordResetToken, hashRefreshToken, verifyAccessToken } from "../src/core/security/tokens.js";

test("access tokens retain the authenticated user and session", () => {
  const token = createAccessToken({
    userId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77",
    sessionId: "018f47f2-7a0b-72c8-b9f0-3b04f629a57c"
  });

  assert.deepEqual(verifyAccessToken(token), {
    userId: "018f47f2-6b6d-7c34-ae31-8f4f17b79b77",
    sessionId: "018f47f2-7a0b-72c8-b9f0-3b04f629a57c"
  });
  const payload = jwt.decode(token);
  assert.equal(payload.exp - payload.iat, 60 * 60);
});

test("refresh tokens are opaque and hashed consistently", () => {
  const token = createRefreshToken();

  assert.ok(token.length >= 64);
  assert.deepEqual(hashRefreshToken(token), hashRefreshToken(token));
  assert.notDeepEqual(hashRefreshToken(token), hashRefreshToken(createRefreshToken()));
});

test("password reset tokens are opaque and stored as fixed-length keyed hashes", () => {
  const token = createPasswordResetToken();
  const other = createPasswordResetToken();
  assert.notEqual(token, other);
  assert.equal(hashPasswordResetToken(token).length, 32);
  assert.deepEqual(hashPasswordResetToken(token), hashPasswordResetToken(token));
  assert.notDeepEqual(hashPasswordResetToken(token), hashPasswordResetToken(other));
});
