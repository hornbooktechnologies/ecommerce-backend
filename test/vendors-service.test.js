import assert from "node:assert/strict";
import test from "node:test";
import { createVendorsService } from "../src/modules/vendors/vendors.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const vendorId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const itemId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const context = { actorUserId: itemId, requestId: "req", ipAddress: "127.0.0.1", userAgent: "test" };
const transaction = (_tenantId, operation) => operation({});

test("vendor offer requires an approved vendor", async () => {
  const dao = {
    async findOfferContext() { return { merchantStatus: "PENDING", taxCategoryId: null, priceListId: itemId }; }
  };
  const service = createVendorsService({ dao, transaction });
  await assert.rejects(() => service.createVendorOffer(tenantId, vendorId, { storeId: itemId,
    variantId: itemId, sellerSku: "SKU", fulfillmentType: "MERCHANT", handlingTimeHours: 24,
    listPrice: 100, salePrice: 90, costPrice: 50 }, context),
  (error) => error.code === "VENDOR_APPROVAL_REQUIRED");
});

test("vendor offer rejects selling price above MRP", async () => {
  const service = createVendorsService({ dao: {}, transaction });
  await assert.rejects(() => service.createVendorOffer(tenantId, vendorId, { storeId: itemId,
    variantId: itemId, sellerSku: "SKU", fulfillmentType: "MERCHANT", handlingTimeHours: 24,
    listPrice: 100, salePrice: 101, costPrice: 50 }, context),
  (error) => error.code === "OFFER_PRICE_INVALID");
});

test("vendor logo upload stores branding, audits the change and removes the old logo", async () => {
  const calls = [];
  const oldLogo = "http://localhost:4000/media/vendor-logos/old.png";
  const newLogo = "http://localhost:4000/media/vendor-logos/new.png";
  const dao = {
    async getVendor({ connection }) { return { vendor: { id: vendorId, displayName: "Demo", logoUrl: connection ? newLogo : oldLogo } }; },
    async updateVendorLogo(input) { calls.push(["update", input.logoUrl]); },
    async insertAudit({ audit }) { calls.push(["audit", audit.action]); }
  };
  const logoStorage = {
    async store() { calls.push(["store"]); return { url: newLogo }; },
    async remove(url) { calls.push(["remove", url]); return true; }
  };
  const service = createVendorsService({ dao, transaction, logoStorage });
  const result = await service.uploadVendorLogo(tenantId, vendorId,
    { buffer: Buffer.from("logo"), mimeType: "image/png", originalName: "logo.png" }, context);
  assert.equal(result.vendor.logoUrl, newLogo);
  assert.deepEqual(calls, [["store"], ["update", newLogo], ["audit", "vendor.logo.updated"], ["remove", oldLogo]]);
});

test("vendor KYC upload stores a private file and creates an auditable pending document", async () => {
  const calls = [];
  const dao = {
    async getVendor() { return { vendor: { id: vendorId }, documents: [] }; },
    async insertVendorDocument({ document }) { calls.push(["insert", document.type, document.fileKey]); },
    async insertAudit({ audit }) { calls.push(["audit", audit.action, audit.entityType]); }
  };
  const documentStorage = {
    async store() { calls.push(["store"]); return { fileKey: "private.pdf", originalName: "gst.pdf",
      mimeType: "application/pdf", byteSize: 12 }; },
    async remove() { calls.push(["remove"]); }
  };
  const service = createVendorsService({ dao, transaction, documentStorage });
  await service.uploadVendorDocument(tenantId, vendorId,
    { documentType: "GST_CERTIFICATE", documentNumber: "GST-1", expiresAt: "" },
    { buffer: Buffer.from("%PDF-"), mimeType: "application/pdf", originalName: "gst.pdf" }, context);
  assert.deepEqual(calls, [["store"], ["insert", "GST_CERTIFICATE", "private.pdf"],
    ["audit", "vendor.document.uploaded", "VENDOR_DOCUMENT"]]);
});

test("vendor KYC decision records reviewer and audit state", async () => {
  const calls = [];
  const dao = {
    async getVendor() { return { vendor: { id: vendorId }, documents: [] }; },
    async getVendorDocument() { return { id: itemId, status: "PENDING" }; },
    async updateVendorDocumentDecision(input) { calls.push(["decision", input.decision, input.actorUserId]); },
    async insertAudit({ audit }) { calls.push(["audit", audit.action]); }
  };
  const service = createVendorsService({ dao, transaction, documentStorage: {} });
  await service.decideVendorDocument(tenantId, vendorId, itemId,
    { decision: "VERIFIED", rejectionReason: "" }, context);
  assert.deepEqual(calls, [["decision", "VERIFIED", itemId], ["audit", "vendor.document.verified"]]);
});
