import assert from "node:assert/strict";
import test from "node:test";
import { createWarrantiesService } from "../src/modules/warranties/warranties.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const warrantyId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const claimId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const context = { actorUserId: userId, requestId: "req", ipAddress: "127.0.0.1", userAgent: "test" };
const transaction = (_tenantId, operation) => operation({});

test("expired warranties cannot open claims", async () => {
  const dao = { async findWarrantyForClaim() { return { id: warrantyId, status: "EXPIRED",
    serialId: userId, serialStatus: "SOLD", endsAt: "2025-01-01", hasOpenClaim: false }; } };
  const service = createWarrantiesService({ dao, transaction });
  await assert.rejects(() => service.createClaim(tenantId, { warrantyRegistrationId: warrantyId,
    issueDescription: "Display has stopped working completely" }, context),
  (error) => error.code === "WARRANTY_NOT_ACTIVE");
});

test("returned serial numbers cannot open claims", async () => {
  const dao = { async findWarrantyForClaim() { return { id: warrantyId, status: "ACTIVE",
    serialId: userId, serialStatus: "AVAILABLE", endsAt: "2027-01-01", hasOpenClaim: false }; } };
  const service = createWarrantiesService({ dao, transaction });
  await assert.rejects(() => service.createClaim(tenantId, { warrantyRegistrationId: warrantyId,
    issueDescription: "Device will no longer power on" }, context),
  (error) => error.code === "WARRANTY_SERIAL_INELIGIBLE");
});

test("resolved claims must be diagnosed first", async () => {
  const dao = { async getClaim() { return { claim: { id: claimId, status: "ASSIGNED" }, events: [] }; } };
  const service = createWarrantiesService({ dao, transaction });
  await assert.rejects(() => service.resolveClaim(tenantId, claimId, {
    resolutionType: "REPAIR", resolutionNotes: "Replaced faulty board" }, context),
  (error) => error.code === "WARRANTY_CLAIM_STATUS_INVALID");
});

test("diagnosing an open claim records the lifecycle event", async () => {
  const calls = [];
  const dao = {
    async getClaim() { return { claim: { id: claimId, status: calls.length ? "DIAGNOSED" : "OPEN" }, events: [] }; },
    async diagnoseClaim(input) { calls.push(["diagnose", input.diagnosisNotes]); },
    async insertClaimEvent({ event }) { calls.push(["event", event.newStatus]); },
    async insertAudit({ audit }) { calls.push(["audit", audit.action]); }
  };
  const service = createWarrantiesService({ dao, transaction });
  const result = await service.diagnoseClaim(tenantId, claimId,
    { diagnosisNotes: "Power rail failure confirmed" }, context);
  assert.equal(result.claim.status, "DIAGNOSED");
  assert.deepEqual(calls.slice(0, 3), [
    ["diagnose", "Power rail failure confirmed"],
    ["event", "DIAGNOSED"],
    ["audit", "warranty.claim.diagnosed"]
  ]);
});
