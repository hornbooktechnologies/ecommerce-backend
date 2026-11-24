import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { enabled } from '../../modules/notifications/order-notifications.events.js';
import * as dao from '../../modules/notifications/order-notifications.dao.js';
import { createOrderNotificationWorker } from '../../modules/notifications/order-notifications.service.js';

// Separate installations may leave all delivery to notifications:work.
export function startOrderLifecycleEmails(logger) {
  if (!enabled() || process.env.ORDER_RECEIPTS_AUTOSTART === 'false') return;
  const controller = new AbortController();
  const worker = createOrderNotificationWorker({ dao: { ...dao, claim: id => dao.claim(id, undefined, true) } });
  const id = 'order-emails:' + randomUUID();
  const done = (async () => {
    while (!controller.signal.aborted) {
      let delay = 5000;
      try {
        const result = await worker.once(id);
        if (result) { delay = 250; logger.info(result, 'Order email processed'); }
      } catch { logger.error('Order email queue unavailable; will retry.'); }
      await sleep(delay, undefined, { signal: controller.signal }).catch(() => {});
    }
  })();
  return () => { controller.abort(); return done; };
}
