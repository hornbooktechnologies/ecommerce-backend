import * as defaultDao from "./inbox.dao.js";

const workflows = Object.freeze({
  "vendor.created": {
    status: "PENDING", onboardingStatus: "SUBMITTED", kind: "VENDOR_AWAITING_APPROVAL",
    title: "Vendor awaiting approval",
    message: "A vendor was added for review. Open Vendors, find the vendor code and review the current business details and documents before approving."
  },
  "vendor.approved": {
    status: "ACTIVE", onboardingStatus: "APPROVED", kind: "VENDOR_APPROVED",
    title: "Vendor approval recorded",
    message: "The vendor you added was approved. Open Vendors to check the current status and remaining setup. Approval does not create portal access, verify bank details or publish offers."
  }
});

export function createVendorApprovalInboxEvents({ dao = defaultDao } = {}) {
  return async function enqueueVendorApprovalInbox({ tenantId, auditId, connection }) {
    const source = await dao.sourceVendorApproval({ tenantId, auditId, connection });
    if (!source || !Object.hasOwn(workflows, source.action)) return;
    const workflow = workflows[source.action];
    if (source.status !== workflow.status || source.onboardingStatus !== workflow.onboardingStatus) return;
    const readers = await dao.staffRecipients({ tenantId, permission: "vendor.read", connection });
    let recipients, permission = "vendor.read";
    if (source.action === "vendor.created") {
      permission = "vendor.manage";
      const reviewers = new Set(await dao.staffRecipients({ tenantId, permission, connection }));
      recipients = readers.filter(userId => reviewers.has(userId));
    } else {
      // Portal access is created after approval. Notify the staff creator, not the contact email.
      // Older records without a creation audit do not have a guessed recipient.
      recipients = source.createdBy && readers.includes(source.createdBy) ? [source.createdBy] : [];
    }
    if (!recipients.length) return;
    const code = String(source.merchantCode || source.vendorId).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0,100);
    await dao.enqueue({ event: {
      tenantId, audience: "ADMIN", permission, recipients,
      key: `VENDOR_APPROVAL:${auditId}:ADMIN`,
      kind: workflow.kind, category: "APPROVALS", entityType: "VENDOR_APPROVAL", entityId: source.vendorId,
      title: workflow.title, message: `Vendor ${code}. ${workflow.message}`
    }, connection });
  };
}

export const enqueueVendorApprovalInbox = createVendorApprovalInboxEvents();
