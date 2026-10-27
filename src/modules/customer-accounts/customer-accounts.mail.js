import "dotenv/config";
import nodemailer from "nodemailer";
import { AppError } from "../../core/errors/app-error.js";

const unavailable = () => new AppError({ code: "CUSTOMER_EMAIL_UNAVAILABLE", message: "Account email delivery is unavailable. Please try again later or contact the store.", status: 503 });
export function mailSettings(scope) {
  let origins;
  try { origins = JSON.parse(process.env.CUSTOMER_STOREFRONT_URLS || "{}"); } catch { throw unavailable(); }
  const origin = origins[`${scope.tenantCode}/${scope.storeCode}`];
  if (!origin || !process.env.SMTP_HOST || !process.env.SMTP_USER || !(process.env.SMTP_PASS || process.env.SMTP_PASSWORD)) throw unavailable();
  const url = new URL(origin);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw unavailable();
  return { origin: url.origin, host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_SECURE || "true") === "true", user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS || process.env.SMTP_PASSWORD, from: process.env.SMTP_FROM || process.env.SMTP_USER };
}
export function createCustomerMailer() {
  return {
    ready: mailSettings,
    async send({ scope, email, purpose, token }) {
      const settings = mailSettings(scope);
      const transport = nodemailer.createTransport({ host: settings.host, port: settings.port, secure: settings.secure,
        requireTLS: true, auth: { user: settings.user, pass: settings.pass }, disableFileAccess: true, disableUrlAccess: true,
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
      const action = purpose === "REGISTER" ? "Verify your email and create your password" : "Reset your password";
      const path = purpose === "REGISTER" ? "verify" : "reset-password";
      try {
        await transport.sendMail({ from: settings.from, to: email,
          subject: `${scope.tenantName}: ${action}`,
          text: `${action} for ${scope.tenantName}.\n\n${settings.origin}/account/${path}#token=${token}\n\nThis single-use link expires in 30 minutes. If you did not request this, ignore this email.` });
      } catch { throw unavailable(); }
      finally { transport.close(); }
    }
  };
}
