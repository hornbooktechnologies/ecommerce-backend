import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../../core/errors/app-error.js";

export const paymentError = (code, message, status = 409) => { throw new AppError({ code, message, status }); };
export function createCredentialVault(keyHex = process.env.PAYMENT_CREDENTIALS_KEY || "") {
  const ready = /^[a-f0-9]{64}$/i.test(keyHex);
  const key = () => {
    if (!ready) paymentError("PAYMENT_ENCRYPTION_NOT_CONFIGURED", "Configure PAYMENT_CREDENTIALS_KEY in the backend before connecting a payment account.", 503);
    return Buffer.from(keyHex, "hex");
  };
  return { ready,
    encrypt(secret, tenantId) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
      cipher.setAAD(Buffer.from(tenantId));
      const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
    },
    decrypt(value, tenantId) {
      const encryptionKey = key();
      try {
        const [version, iv, tag, payload] = value.split(":");
        if (version !== "v1") throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(iv, "base64"));
        decipher.setAAD(Buffer.from(tenantId)); decipher.setAuthTag(Buffer.from(tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(payload, "base64")), decipher.final()]).toString("utf8");
      } catch { paymentError("PAYMENT_ACCOUNT_UNAVAILABLE", "The payment account cannot be unlocked. Contact the store administrator.", 503); }
    }
  };
}

export function verifySignature(orderId, paymentId, signature, secret) {
  if (!/^[a-f0-9]{64}$/i.test(signature || "")) return false;
  const expected = createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || !/^[a-f0-9]{64}$/i.test(signature || "")) return false;
  return timingSafeEqual(createHmac("sha256", secret).update(rawBody).digest(), Buffer.from(signature, "hex"));
}

export function createRazorpayGateway({ fetcher = fetch } = {}) {
  async function request(account, path, body) {
    if (!/^rzp_test_[A-Za-z0-9]+$/.test(account.keyId)) paymentError("TEST_KEYS_REQUIRED", "Only Razorpay Test Mode keys are accepted.", 422);
    try {
      const response = await fetcher(`https://api.razorpay.com/v1/${path}`, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Basic ${Buffer.from(`${account.keyId}:${account.secret}`).toString("base64")}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (!response.ok) paymentError("PAYMENT_PROVIDER_UNAVAILABLE", "Razorpay could not complete this request. Check the test credentials or retry this same order.", 502);
      return await response.json();
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Never propagate a provider request or Authorization header into logs.
      paymentError("PAYMENT_PROVIDER_UNAVAILABLE", "Payment services are temporarily unavailable. Retry this same order.", 503);
    }
  }
  return {
    validate: (account) => request(account, "orders?count=1"),
    createOrder: (account, amount, receipt) => request(account, "orders", { amount, currency: "INR", receipt, partial_payment: false }),
    payments: (account, orderId) => request(account, `orders/${encodeURIComponent(orderId)}/payments`),
    payment: (account, paymentId) => request(account, `payments/${encodeURIComponent(paymentId)}`)
  };
}
