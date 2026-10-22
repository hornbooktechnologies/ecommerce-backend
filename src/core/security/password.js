import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const PARAMETERS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derivedKey = await scryptAsync(password, salt, KEY_LENGTH, PARAMETERS);

  return [
    "scrypt",
    PARAMETERS.N,
    PARAMETERS.r,
    PARAMETERS.p,
    salt.toString("base64url"),
    Buffer.from(derivedKey).toString("base64url")
  ].join(":");
}

export async function verifyPassword(password, encodedHash) {
  const [algorithm, n, r, p, saltValue, hashValue] = String(encodedHash).split(":");
  if (algorithm !== "scrypt" || !n || !r || !p || !saltValue || !hashValue) {
    return false;
  }

  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = await scryptAsync(password, Buffer.from(saltValue, "base64url"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: PARAMETERS.maxmem
    });

    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
