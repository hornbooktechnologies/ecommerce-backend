import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/core/errors/app-error.js";
import { createBulkOperationsService } from "../src/modules/bulk-operations/bulk-operations.service.js";

const tenantId = "019a3000-1111-7111-8111-111111111111";
const jobId = "019a3000-2222-7222-8222-222222222222";
const context = { actorUserId: "019a3000-3333-7333-8333-333333333333", requestId: "recovery-fixture" };

// Models transaction rollback and lost COMMIT acknowledgements, not a MariaDB
// integration test. Real lock/race/permission checks remain separately required.
function harness(options = {}) {
  let state = { job: { id: jobId, type: "INVENTORY", status: "READY", recoveryVersion: 1,
    invalidRows: 0, committedRows: 0, failedRows: 0, leaseActive: false }, stock: 0,
  rows: [1, 2].map((n) => ({ id: `row-${n}`, status: "VALID", errors: [], normalized: { quantity: n } })) };
  let failMark = options.failMark; let ambiguous = options.ambiguous; let failFinish = options.failFinish;
  let activeConnection = null;
  const job = () => ({ ...state.job, canResume: state.job.status === "COMMITTING" && !state.job.leaseActive && state.job.recoveryVersion === 1,
    needsManualReview: state.job.status === "COMMITTING" && state.job.recoveryVersion !== 1 });
  const connectionCheck = (connection) => assert.equal(connection, activeConnection);
  const dao = {
    async findJob() { return job(); },
    async listRows() { return structuredClone(state.rows); },
    async claimJob({ runToken, connection }) {
      connectionCheck(connection);
      if (state.job.status !== "READY" && !job().canResume) return false;
      Object.assign(state.job, { status: "COMMITTING", recoveryVersion: 1, leaseActive: true, runToken }); return true;
    },
    async auditRun({ connection }) { connectionCheck(connection); },
    async lockRun({ runToken, connection }) {
      connectionCheck(connection);
      return !options.replaced && state.job.status === "COMMITTING" && state.job.runToken === runToken;
    },
    async findNextRow({ connection }) { connectionCheck(connection); return state.rows.find((row) => row.status === "VALID") || null; },
    async markRow({ rowId, status, errors = [], connection }) {
      connectionCheck(connection);
      if (failMark) { failMark = false; throw new Error("fixture disconnect before row result"); }
      Object.assign(state.rows.find((row) => row.id === rowId), { status, errors });
      state.job[status === "COMMITTED" ? "committedRows" : "failedRows"] += 1;
    },
    async finishCommit({ connection }) {
      connectionCheck(connection);
      if (failFinish) { failFinish = false; throw new Error("fixture completion event failure"); }
      state.job.status = state.job.failedRows ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
    }
  };
  const transaction = async (_tenantId, operation) => {
    const before = structuredClone(state); const connection = {};
    activeConnection = connection;
    let result;
    try { result = await operation(connection); } catch (error) { state = before; throw error; }
    finally { activeConnection = null; }
    if (ambiguous && state.job.committedRows > before.job.committedRows) {
      ambiguous = false; throw new Error("fixture lost COMMIT acknowledgement");
    }
    return result;
  };
  const service = createBulkOperationsService({ dao, transaction, rowServices: (connection) => ({
    inventoryService: { async receiveStock(_tenantId, input) {
      connectionCheck(connection); state.stock += input.quantity;
      if (options.businessError) throw new AppError({ code: "INVALID_RECEIPT", message: "Fixture business validation", status: 422 });
    } }
  }) });
  return { service, dao, state: () => state, expire() { state.job.leaseActive = false; } };
}

test("row-result failure rolls back stock; resume applies each unfinished row once", async () => {
  const h = harness({ failMark: true });
  await assert.rejects(h.service.commitImport(tenantId, "INVENTORY", jobId, context), { code: "IMPORT_INTERRUPTED" });
  assert.equal(h.state().stock, 0); assert.equal(h.state().rows[0].status, "VALID");
  h.expire();
  assert.equal((await h.service.commitImport(tenantId, "INVENTORY", jobId, context)).status, "COMPLETED");
  assert.equal(h.state().stock, 3);
  await h.service.commitImport(tenantId, "INVENTORY", jobId, context);
  assert.equal(h.state().stock, 3);
});

test("lost COMMIT acknowledgement preserves the receipt and resume skips its row", async () => {
  const h = harness({ ambiguous: true });
  await assert.rejects(h.service.commitImport(tenantId, "INVENTORY", jobId, context), { code: "IMPORT_INTERRUPTED" });
  assert.equal(h.state().stock, 1); assert.equal(h.state().rows[0].status, "COMMITTED");
  h.expire(); await h.service.commitImport(tenantId, "INVENTORY", jobId, context);
  assert.equal(h.state().stock, 3);
});

test("completion-event failure can finalize without replaying receipts", async () => {
  const h = harness({ failFinish: true });
  await assert.rejects(h.service.commitImport(tenantId, "INVENTORY", jobId, context), { code: "IMPORT_INTERRUPTED" });
  assert.equal(h.state().stock, 3);
  h.expire(); await h.service.commitImport(tenantId, "INVENTORY", jobId, context);
  assert.equal(h.state().stock, 3); assert.equal(h.state().job.status, "COMPLETED");
});

test("known business errors roll back mutations and remain failed on repeat commit", async () => {
  const h = harness({ businessError: true });
  const result = await h.service.commitImport(tenantId, "INVENTORY", jobId, context);
  assert.equal(result.status, "COMPLETED_WITH_ERRORS"); assert.equal(result.failedRows, 2);
  assert.equal(h.state().stock, 0);
  await h.service.commitImport(tenantId, "INVENTORY", jobId, context);
  assert.equal(h.state().stock, 0);
});

test("legacy interrupted imports, active runs and stale tokens cannot replay rows", async () => {
  const legacy = harness(); Object.assign(legacy.state().job, { status: "COMMITTING", recoveryVersion: 0 });
  await assert.rejects(legacy.service.commitImport(tenantId, "INVENTORY", jobId, context), { code: "IMPORT_REVIEW_REQUIRED" });
  const busy = harness(); Object.assign(busy.state().job, { status: "COMMITTING", leaseActive: true });
  await assert.rejects(busy.service.commitImport(tenantId, "INVENTORY", jobId, context), { code: "IMPORT_BUSY" });
  const replaced = harness({ replaced: true });
  await assert.rejects(replaced.service.commitImport(tenantId, "INVENTORY", jobId, context), { code: "IMPORT_RUN_REPLACED" });
  for (const h of [legacy, busy, replaced]) assert.equal(h.state().stock, 0);
});

test("type mismatch is rejected before claim or stock mutation", async () => {
  const h = harness();
  await assert.rejects(h.service.commitImport(tenantId, "PRODUCT", jobId, context), { code: "IMPORT_JOB_NOT_FOUND" });
  assert.equal(h.state().job.status, "READY"); assert.equal(h.state().stock, 0);
});

test("identical inventory data reuses its original job across file names and column order", async () => {
  const h = harness(); const fingerprints = [];
  h.dao.findInventoryFile = async ({ tenantId: receivedTenant, fingerprint }) => {
    assert.equal(receivedTenant, tenantId); fingerprints.push(fingerprint); return jobId;
  };
  const one = await h.service.validateImport(tenantId, "INVENTORY", {
    fileName: "one.csv", csv: "warehouse_code,offer_id,quantity\r\nBLR,offer,2"
  }, context);
  const two = await h.service.validateImport(tenantId, "INVENTORY", {
    fileName: "two.csv", csv: "quantity,offer_id,warehouse_code\r\n2,offer,BLR"
  }, context);
  assert.equal(one.reused, true); assert.equal(two.id, jobId);
  assert.equal(fingerprints[0], fingerprints[1]); assert.equal(h.state().stock, 0);
});
