import nodemailer from "nodemailer";
import { mailSettings } from "../customer-accounts/customer-accounts.mail.js";
import { messages } from "./order-notifications.events.js";

const oneLine = (value) => String(value || "").replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim();
export function notificationMessage(job, recipient, settings) {
  const [title, explanation] = messages[job.payload.kind];
  return {
    from: settings.from,
    to: { address: recipient.email },
    // Stable identity across retries. SMTP providers do not guarantee deduplication.
    messageId: `<order-notification-${job.id}@${new URL(settings.origin).hostname}>`,
    subject: `${oneLine(recipient.storeName)}: ${title} — ${oneLine(recipient.orderNumber)}`,
    text: `${title}\n\nStore: ${oneLine(recipient.storeName)}\nOrder: ${oneLine(recipient.orderNumber)}`
      + (recipient.returnNumber ? `\nCase: ${oneLine(recipient.returnNumber)}` : "")
      + `\n\n${explanation}\n\nThis email reports a recorded update. For the latest status, sign in to My Orders:\n`
      + `${settings.origin}/account/orders\n\nIf you need help, contact the store through its website.`
  };
}

export function createOrderMailer({ settingsFor = mailSettings, createTransport = nodemailer.createTransport } = {}) {
  return {
    async send(job, recipient) {
      const settings = settingsFor(recipient);
      const transport = createTransport({ host: settings.host, port: settings.port, secure: settings.secure,
        requireTLS: true, auth: { user: settings.user, pass: settings.pass },
        disableFileAccess: true, disableUrlAccess: true, connectionTimeout: 10000,
        greetingTimeout: 10000, socketTimeout: 15000 });
      let timer;
      try {
        const result = await Promise.race([
          transport.sendMail(notificationMessage(job, recipient, settings)),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
              transport.close();
              reject(Object.assign(new Error("SMTP deadline exceeded"), { code: "ETIMEDOUT" }));
            }, 30000);
          })
        ]);
        if (!result.accepted?.some((address) => String(address).toLowerCase() === recipient.email.toLowerCase())) {
          throw Object.assign(new Error("Recipient was not accepted"), { code: "EENVELOPE" });
        }
      } finally {
        clearTimeout(timer);
        transport.close();
      }
    }
  };
}
