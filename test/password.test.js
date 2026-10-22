import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/core/security/password.js";

test("password hashes are salted and verifiable", async () => {
  const first = await hashPassword("a-long-local-test-password");
  const second = await hashPassword("a-long-local-test-password");

  assert.notEqual(first, second);
  assert.equal(await verifyPassword("a-long-local-test-password", first), true);
  assert.equal(await verifyPassword("wrong-password", first), false);
});
