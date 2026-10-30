import * as defaultDao from "./inbox.dao.js";

const messages = Object.freeze({
  CLAIM_OPENED: {
    title: "Warranty claim opened", states: ["OPEN"],
    customer: "Your warranty claim was opened and is awaiting review. This does not confirm a repair, replacement or refund.",
    admin: "A warranty claim needs review. Check coverage and the reported issue before diagnosis."
  },
  CLAIM_ASSIGNED: {
    title: "Warranty claim assigned to you", states: ["ASSIGNED", "DIAGNOSED"],
    admin: "You have been assigned this warranty claim. Open Warranties and find the claim in the Claim queue."
  },
  CLAIM_DIAGNOSED: {
    title: "Warranty claim assessed", states: ["DIAGNOSED"],
    customer: "The store recorded an assessment of your warranty claim. Contact the store for the outcome and next steps; no repair, replacement or refund is confirmed by this update.",
    admin: "Diagnosis was recorded for this warranty claim. Review the case before recording a resolution."
  },
  CLAIM_RESOLVED: {
    title: "Warranty resolution recorded", states: ["RESOLVED"],
    customer: "The store recorded a resolution for your warranty claim. Contact the store for the details. This update does not confirm a refund payment or replacement dispatch.",
    admin: "A resolution was recorded for this warranty claim. Review any remaining actions before closing the case; refund and replacement fulfilment remain separate."
  },
  CLAIM_CLOSED: {
    title: "Warranty claim closed", states: ["CLOSED"],
    customer: "The store closed your warranty claim. Contact the store if you need help. Closure alone does not confirm that a refund was paid or a replacement was delivered.",
    admin: "This warranty claim was closed. Case closure does not confirm refund payment or replacement delivery."
  }
});

export function createWarrantyInboxEvents({ dao = defaultDao } = {}) {
  return async function enqueueWarrantyInbox({ tenantId, eventId, connection }) {
    const event = await dao.sourceWarrantyEvent({ tenantId, eventId, connection });
    if (!event) return;
    const content = messages[event.type];
    if (!content || !content.states.includes(event.status)) return;
    const source = await dao.sourceOrder({ tenantId, orderId: event.orderId, connection });
    if (!source) return;
    const base = { tenantId, storeId: source.storeId, orderId: event.orderId,
      kind: `WARRANTY_${event.type}`, category: "WARRANTIES",
      entityType: "WARRANTY_CLAIM", entityId: event.claimId, title: content.title };
    let recipients = await dao.staffRecipients({ tenantId, permission: "warranty.read", connection });
    if (event.type === "CLAIM_ASSIGNED") recipients = recipients.filter(userId => userId === event.assignedTo);
    const customerRecipients = content.customer && source.customerId && source.customerId === event.customerId
      ? [source.customerId] : [];
    for (const group of [
      { audience: "ADMIN", permission: "warranty.read", recipients, text: content.admin },
      { audience: "CUSTOMER", permission: null, recipients: customerRecipients, text: content.customer }
    ]) {
      if (!group.recipients.length) continue;
      await dao.enqueue({ event: { ...base, audience: group.audience, permission: group.permission,
        recipients: group.recipients, message: `Claim ${event.number}. ${group.text}`,
        key: `WARRANTY_EVENT:${eventId}:${group.audience}` }, connection });
    }
  };
}

export const enqueueWarrantyInbox = createWarrantyInboxEvents();
