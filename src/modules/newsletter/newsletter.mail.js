import nodemailer from "nodemailer";
import { mailSettings } from "../customer-accounts/customer-accounts.mail.js";
import { AppError } from "../../core/errors/app-error.js";

export const emailUnavailable = () => new AppError({ code: "NEWSLETTER_EMAIL_UNAVAILABLE",
  message: "Newsletter confirmation email is unavailable. Please try again later.", status: 503 });
function settings(scope) { try { return mailSettings(scope); } catch { throw emailUnavailable(); } }
export function createNewsletterMailer() {
  return {
    ready: settings,
    async send({ scope, email, confirmToken, unsubscribeToken }) {
      const config = settings(scope);
      const transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure,
        requireTLS: true, auth: { user: config.user, pass: config.pass }, disableFileAccess: true, disableUrlAccess: true,
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
      const name = String(scope.tenantName).replace(/[\r\n]/g, " ");
      try {
        await transport.sendMail({ from: config.from, to: email, subject: `${name}: confirm your newsletter subscription`,
          text: `Confirm that you want to receive new arrivals, collections and offers from ${name}.\n\n`
            + `Open this link, then select Confirm subscription:\n${config.origin}/newsletter/confirm#token=${confirmToken}\n\n`
            + `The confirmation link expires in 30 minutes. You are not subscribed until you confirm. If you did not request this, ignore this email.\n\n`
            + `To stop or withdraw this subscription request:\n${config.origin}/newsletter/unsubscribe#token=${unsubscribeToken}\n` });
      } catch { throw emailUnavailable(); }
      finally { transport.close(); }
    }
  };
}
