import * as defaultDao from "./inbox.dao.js";

const labels = Object.freeze({ PRODUCT: "Product", PRICING: "Pricing", INVENTORY: "Inventory" });
const count = value => Number.isSafeInteger(value) && value >= 0;

export function createBulkImportInboxEvents({ dao = defaultDao } = {}) {
  return async function enqueueBulkImportInbox({ tenantId, jobId, stage, connection }) {
    if (!["VALIDATION", "COMPLETION"].includes(stage)) return;
    const job = await dao.sourceBulkImport({ tenantId, jobId, connection });
    if (!job || !Object.hasOwn(labels, job.type) || !count(job.total) || job.total === 0) return;
    let title, message, kind;
    if (stage === "VALIDATION") {
      if (job.status !== "VALIDATED_WITH_ERRORS" || !count(job.valid) || !count(job.invalid)
        || !job.invalid || job.valid + job.invalid !== job.total) return;
      kind = "BULK_IMPORT_VALIDATION_ERRORS";
      title = `${labels[job.type]} import needs corrections`;
      message = `${job.invalid} of ${job.total} rows failed validation. No rows were imported. Open imports, find this job and download its error report before uploading a corrected file.`;
    } else {
      if (!["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(job.status)
        || !count(job.committed) || !count(job.failed) || job.committed + job.failed !== job.total
        || (job.status === "COMPLETED") !== (job.failed === 0)) return;
      kind = job.failed ? "BULK_IMPORT_COMPLETED_WITH_ERRORS" : "BULK_IMPORT_COMPLETED";
      title = job.failed ? `${labels[job.type]} import finished with errors` : `${labels[job.type]} import completed`;
      message = job.failed
        ? `${job.committed} of ${job.total} rows reported committed; ${job.failed} reported failed. Review the error report and current records before retrying failed rows. Do not re-import successful rows; stock receipts can be duplicated.`
        : `All ${job.total} rows were committed. Open imports to review the job. This does not automatically publish products or change storefront availability requirements.`;
    }
    const participants = new Set([job.createdBy, stage === "COMPLETION" ? job.committedBy : null].filter(Boolean));
    const eligible = await dao.staffRecipients({ tenantId, permission: "bulk.read", connection });
    const recipients = eligible.filter(userId => participants.has(userId));
    if (!recipients.length) return;
    await dao.enqueue({ event: {
      tenantId, audience: "ADMIN", permission: "bulk.read", recipients,
      kind, category: "IMPORTS", entityType: "BULK_IMPORT", entityId: jobId,
      key: `BULK_IMPORT:${jobId}:${stage}:ADMIN`, title,
      message: `Import ${jobId}. ${message}`
    }, connection });
  };
}

export const enqueueBulkImportInbox = createBulkImportInboxEvents();
