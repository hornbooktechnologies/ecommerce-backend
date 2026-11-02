import nodemailer from "nodemailer";
import { env } from "../../config/env.js";
import { AppError } from "../../core/errors/app-error.js";

const unavailable = () => new AppError({ code: "ADMIN_EMAIL_UNAVAILABLE", message: "Account email delivery is unavailable. Please try again later or contact your administrator.", status: 503 });
export function adminResetMailSettings() {
  let url;
  try { url = new URL(env.adminAppUrl); } catch { throw unavailable(); }
  const local = env.nodeEnv !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE === undefined ? port === 465 : process.env.SMTP_SECURE === "true";
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password
    || !process.env.SMTP_HOST || !process.env.SMTP_USER || !(process.env.SMTP_PASS || process.env.SMTP_PASSWORD)
    || !Number.isInteger(port) || port < 1 || port > 65535 || !from || /[\r\n]/.test(from)
    || (process.env.SMTP_SECURE !== undefined && !["true", "false"].includes(process.env.SMTP_SECURE))) throw unavailable();
  return { origin: url.origin, host: process.env.SMTP_HOST, port, secure, from,
    user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || process.env.SMTP_PASSWORD };
}
export function createAdminResetMailer() {
  return { ready: adminResetMailSettings, async send({ email, token }) {
    const config = adminResetMailSettings();
    const transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure,
      requireTLS: true, auth: { user: config.user, pass: config.pass }, disableFileAccess: true, disableUrlAccess: true,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
    try {
      const result = await transport.sendMail({ from: config.from, to: [{ address: email }], subject: "Commerce OS: reset your admin password",
        text: `A password reset was requested for your Commerce OS account.\n\nOpen this link to choose a new password:\n${config.origin}/reset-password#token=${encodeURIComponent(token)}\n\nThis single-use link expires in 30 minutes. Requesting it does not change your password or sign you out. Completing the reset signs out all devices.\n\nIf you did not request this, ignore this email. Never share this link.` });
      if (!result.accepted?.length || result.rejected?.length) throw unavailable();
    } catch { throw unavailable(); }
    finally { transport.close(); }
  } };
}
