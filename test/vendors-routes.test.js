import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const vendorId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const storeId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const variantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b44";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) });
  next();
}
function allow() { return (_req, _res, next) => next(); }
function service(overrides = {}) {
  return {
    async listVendorOptions() { return { stores: [], variants: [] }; },
    async listVendors(_tenantId, filters) { return { items: [], total: 0, page: filters.page,
      pageSize: filters.pageSize, totalPages: 1, summary: {} }; },
    async getVendor() { return { vendor: { id: vendorId }, stores: [], offers: [], documents: [] }; },
    async createVendor() { return { vendor: { id: vendorId }, stores: [], offers: [], documents: [] }; },
    async updateVendor() { return { vendor: { id: vendorId }, stores: [], offers: [], documents: [] }; },
    async uploadVendorLogo() { return { vendor: { id: vendorId, logoUrl: "http://localhost/logo.png" }, stores: [], offers: [], documents: [] }; },
    async uploadVendorDocument() { return { vendor: { id: vendorId }, stores: [], offers: [], documents: [] }; },
    async downloadVendorDocument() { return { buffer: Buffer.from("document"), mimeType: "application/pdf", fileName: "kyc.pdf" }; },
    async decideVendorDocument() { return { vendor: { id: vendorId }, stores: [], offers: [], documents: [] }; },
    async approveVendor() { return { vendor: { id: vendorId, status: "ACTIVE" } }; },
    async suspendVendor() { return { vendor: { id: vendorId, status: "SUSPENDED" } }; },
    async restoreVendor() { return { vendor: { id: vendorId, status: "ACTIVE" } }; },
    async inviteVendorUser() { return { id: userId, email: "seller@example.com",
      status: "ACTIVE", vendorId, roleKey: "vendor_owner" }; },
    async createVendorOffer() { return { vendor: { id: vendorId }, offers: [{ id: variantId }] }; },
    async updateVendorOffer() { return { vendor: { id: vendorId }, offers: [] }; },
    ...overrides
  };
}
function app(vendorsService = service()) {
  return createApp({ vendorsService, tenantAccessResolver: resolveTenant,
    tenantPermissionAuthorization: allow });
}

test("vendor routes require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/vendors");
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("vendor directory normalizes filters and pagination", async () => {
  let received;
  const response = await request(app(service({ async listVendors(receivedTenantId, filters) {
    received = { receivedTenantId, filters };
    return { items: [], total: 0, page: filters.page, pageSize: filters.pageSize, totalPages: 1, summary: {} };
  } }))).get("/api/admin/v1/vendors?status=pending&page=2&pageSize=10")
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual({ receivedTenantId: received.receivedTenantId, filters: { ...received.filters } },
    { receivedTenantId: tenantId, filters: { search: "", status: "PENDING", page: 2, pageSize: 10 } });
});

test("vendor onboarding normalizes Indian business identifiers", async () => {
  let received;
  const input = { merchantCode: "demo_vendor", displayName: "Demo Vendor", legalName: "Demo Vendor Private Limited",
    pan: "abcde1234f", gstin: "29abcde1234f1z5", supportEmail: "OPS@EXAMPLE.COM",
    supportPhone: "+91 9876543210", businessType: "private_limited", contactPerson: "Demo Owner",
    storeIds: [storeId], address: { line1: "12 Market Road", city: "Bengaluru", stateCode: "ka",
      stateName: "Karnataka", postalCode: "560001" } };
  const response = await request(app(service({ async createVendor(receivedTenantId, body) {
    received = { receivedTenantId, body }; return { vendor: { id: vendorId } };
  } }))).post("/api/admin/v1/vendors").set("authorization", `Bearer ${token}`).send(input);
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.body.merchantCode, "DEMO_VENDOR");
  assert.equal(received.body.pan, "ABCDE1234F");
  assert.equal(received.body.gstin, "29ABCDE1234F1Z5");
  assert.equal(received.body.businessType, "PRIVATE_LIMITED");
});

test("vendor offer validates selling price input", async () => {
  const response = await request(app()).post(`/api/admin/v1/vendors/${vendorId}/offers`)
    .set("authorization", `Bearer ${token}`).send({ storeId, variantId, sellerSku: "DEMO-SKU",
      listPrice: 1000, salePrice: 0 });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("vendor portal invitation normalizes account input", async () => {
  let received;
  const response = await request(app(service({ async inviteVendorUser(receivedTenantId,
    receivedVendorId, input) { received = { receivedTenantId, receivedVendorId, input };
    return { id: userId, email: input.email, status: "ACTIVE", vendorId: receivedVendorId,
      roleKey: input.roleKey }; } })))
    .post(`/api/admin/v1/vendors/${vendorId}/invitations`)
    .set("authorization", `Bearer ${token}`)
    .send({ email: "SELLER@EXAMPLE.COM", firstName: "Ananya", lastName: "Rao",
      temporaryPassword: "Tmp!SafePassword42", roleKey: "vendor_catalog_manager" });
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.receivedVendorId, vendorId);
  assert.equal(received.input.email, "seller@example.com");
  assert.equal(received.input.roleKey, "vendor_catalog_manager");
});

test("vendor logo upload forwards the binary image", async () => {
  let received;
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const response = await request(app(service({ async uploadVendorLogo(receivedTenantId,
    receivedVendorId, file) { received = { receivedTenantId, receivedVendorId, file };
    return { vendor: { id: receivedVendorId, logoUrl: "http://localhost/logo.png" } }; } })))
    .put(`/api/admin/v1/vendors/${vendorId}/logo?fileName=vendor-logo.png`)
    .set("authorization", `Bearer ${token}`).set("content-type", "image/png").send(image);
  assert.equal(response.status, 200);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.receivedVendorId, vendorId);
  assert.equal(received.file.originalName, "vendor-logo.png");
  assert.deepEqual(received.file.buffer, image);
});

test("vendor KYC upload normalizes metadata and forwards the private file", async () => {
  let received;
  const documentId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b33";
  const pdf = Buffer.from("%PDF-1.7\nKYC");
  const response = await request(app(service({ async uploadVendorDocument(receivedTenantId,
    receivedVendorId, input, file) { received = { receivedTenantId, receivedVendorId, input, file };
    return { vendor: { id: receivedVendorId }, documents: [{ id: documentId }] }; } })))
    .post(`/api/admin/v1/vendors/${vendorId}/documents/upload?fileName=gst.pdf&documentType=gst_certificate&documentNumber=29ABCDE1234F1Z5&expiresAt=`)
    .set("authorization", `Bearer ${token}`).set("content-type", "application/pdf").send(pdf);
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.documentType, "GST_CERTIFICATE");
  assert.equal(received.input.documentNumber, "29ABCDE1234F1Z5");
  assert.deepEqual(received.file.buffer, pdf);
});

test("vendor KYC decision requires a rejection reason", async () => {
  const documentId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b33";
  const response = await request(app()).post(`/api/admin/v1/vendors/${vendorId}/documents/${documentId}/decision`)
    .set("authorization", `Bearer ${token}`).send({ decision: "REJECTED", rejectionReason: "" });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("vendor KYC file download remains a private attachment", async () => {
  const documentId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b33";
  const response = await request(app()).get(`/api/admin/v1/vendors/${vendorId}/documents/${documentId}/file`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /application\/pdf/);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.match(response.headers["content-disposition"], /kyc\.pdf/);
});
