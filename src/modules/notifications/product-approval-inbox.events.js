import * as defaultDao from "./inbox.dao.js";

const workflows = Object.freeze({
  "catalog.product.submitted": {
    status: "PENDING", kind: "PRODUCT_SUBMITTED", title: "Product awaiting approval",
    message: "A product was submitted for review. Open the catalog, find it by product code and review its current details before approving or requesting changes."
  },
  "catalog.product.approved": {
    status: "APPROVED", kind: "PRODUCT_APPROVED", title: "Your product submission was approved",
    message: "Your product submission was approved. Approval does not publish the product or add stock. Open the catalog to check its current status and remaining setup."
  },
  "catalog.product.rejected": {
    status: "REJECTED", kind: "PRODUCT_REJECTED", title: "Your product submission needs changes",
    message: "Your product submission was rejected for changes. Open the catalog to read the review note, make the required changes and submit it again."
  }
});

export function createProductApprovalInboxEvents({ dao = defaultDao } = {}) {
  return async function enqueueProductApprovalInbox({ tenantId, auditId, connection }) {
    const source = await dao.sourceProductApproval({ tenantId, auditId, connection });
    if (!source || !Object.hasOwn(workflows, source.action)) return;
    const workflow = workflows[source.action];
    if (source.status !== workflow.status) return;
    const readers = await dao.staffRecipients({ tenantId, permission: "catalog.product.read", connection });
    let recipients, permission = "catalog.product.read";
    if (source.action === "catalog.product.submitted") {
      permission = "catalog.product.approve";
      const reviewers = new Set(await dao.staffRecipients({ tenantId, permission, connection }));
      recipients = readers.filter(userId => reviewers.has(userId));
    } else {
      // Do not guess the creator/owner when an older product lacks a submission audit.
      recipients = source.submittedBy && readers.includes(source.submittedBy) ? [source.submittedBy] : [];
    }
    if (!recipients.length) return;
    const code = String(source.productCode || source.productId).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0,100);
    await dao.enqueue({ event: {
      tenantId, audience: "ADMIN", permission, recipients,
      key: `PRODUCT_APPROVAL:${auditId}:ADMIN`,
      kind: workflow.kind, category: "APPROVALS", entityType: "PRODUCT_APPROVAL", entityId: source.productId,
      title: workflow.title, message: `Product ${code}. ${workflow.message}`
    }, connection });
  };
}

export const enqueueProductApprovalInbox = createProductApprovalInboxEvents();
