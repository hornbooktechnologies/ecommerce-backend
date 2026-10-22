import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAccessToken } from "../src/core/security/tokens.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const userId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";
const registrationId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const categoryId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b55";
const seriesId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b44";
const sellerOrderId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b33";
const documentId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b22";
const token = createAccessToken({ userId, sessionId: "018f47f2-6b6d-7c34-ae31-8f4f17b79baa" });

function resolveTenant(req, _res, next) {
  req.context = Object.freeze({ ...req.context, tenant: Object.freeze({ tenantId, assignments: [] }) });
  next();
}

function allow() { return (_req, _res, next) => next(); }

function service(overrides = {}) {
  return {
    async getWorkspace() { return { registrations: [], categories: [], stores: [], summary: {} }; },
    async createRegistration() { return { registrations: [{ id: registrationId }], categories: [], stores: [], summary: {} }; },
    async updateRegistration() { return { registrations: [{ id: registrationId }], categories: [], stores: [], summary: {} }; },
    async createCategory() { return { registrations: [], categories: [{ id: categoryId }], stores: [], summary: {} }; },
    async updateCategory() { return { registrations: [], categories: [{ id: categoryId }], stores: [], summary: {} }; },
    async createRate() { return { registrations: [], categories: [{ id: categoryId }], stores: [], summary: {} }; },
    async updateRate() { return { registrations: [], categories: [{ id: categoryId }], stores: [], summary: {} }; },
    async createInvoiceSeries() { return { registrations: [], categories: [], invoiceSeries: [{ id: seriesId }], stores: [], summary: {} }; },
    async updateInvoiceSeries() { return { registrations: [], categories: [], invoiceSeries: [{ id: seriesId }], stores: [], summary: {} }; },
    async issueTaxInvoice() { return { taxDocuments: [{ id: seriesId }], invoiceCandidates: [] }; },
    async getTaxDocument() { return { id: documentId, documentNumber: "INV/000001" }; },
    async getTaxDocumentPdf() { return { buffer: Buffer.from("%PDF-demo"), filename: "tax-invoice-INV-000001.pdf" }; },
    ...overrides
  };
}

function app(taxesService = service()) {
  return createApp({ taxesService, tenantAccessResolver: resolveTenant,
    tenantPermissionAuthorization: allow });
}

test("tax settings require authentication", async () => {
  const response = await request(app()).get("/api/admin/v1/taxes");
  assert.equal(response.status, 401);
});

test("GST registration input is normalized and tenant scoped", async () => {
  let received;
  const response = await request(app(service({
    async createRegistration(receivedTenantId, input) {
      received = { receivedTenantId, input };
      return { registrations: [{ id: registrationId }], categories: [], stores: [], summary: {} };
    }
  }))).post("/api/admin/v1/taxes/registrations")
    .set("authorization", `Bearer ${token}`)
    .send({ gstin: "29abcde1234f1z5", legalName: "Hornbook Retail Private Limited",
      tradeName: "Hornbook Retail", registrationType: "regular", stateCode: "29",
      stateName: "Karnataka", line1: "12 Residency Road", city: "Bengaluru", postalCode: "560001" });
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.gstin, "29ABCDE1234F1Z5");
  assert.equal(received.input.registrationType, "REGULAR");
});

test("GST registration rejects a state code that does not match GSTIN", async () => {
  const response = await request(app()).post("/api/admin/v1/taxes/registrations")
    .set("authorization", `Bearer ${token}`)
    .send({ gstin: "29ABCDE1234F1Z5", legalName: "Hornbook Retail Private Limited",
      stateCode: "27", stateName: "Maharashtra", line1: "12 Residency Road",
      city: "Mumbai", postalCode: "400001" });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
});

test("tax category accepts India HSN classification", async () => {
  let received;
  const response = await request(app(service({
    async createCategory(_tenantId, input) { received = input; return { categories: [{ id: categoryId }] }; }
  }))).post("/api/admin/v1/taxes/categories")
    .set("authorization", `Bearer ${token}`)
    .send({ code: "electronics-18", name: "Consumer electronics", supplyType: "goods", hsnSacCode: "8517" });
  assert.equal(response.status, 201);
  assert.equal(received.code, "ELECTRONICS-18");
  assert.equal(received.supplyType, "GOODS");
});

test("GST slab forwards rate and effective dates", async () => {
  let received;
  const response = await request(app(service({
    async createRate(receivedTenantId, receivedCategoryId, input) {
      received = { receivedTenantId, receivedCategoryId, input }; return { categories: [] };
    }
  }))).post(`/api/admin/v1/taxes/categories/${categoryId}/rates`)
    .set("authorization", `Bearer ${token}`)
    .send({ gstRate: 18, cessRate: 0, effectiveFrom: "2026-04-01", status: "active" });
  assert.equal(response.status, 201);
  assert.equal(received.receivedCategoryId, categoryId);
  assert.equal(received.input.gstRate, 18);
  assert.equal(received.input.status, "ACTIVE");
});

test("invoice series input is normalized and tenant scoped", async () => {
  let received;
  const response = await request(app(service({
    async createInvoiceSeries(receivedTenantId, input) {
      received = { receivedTenantId, input };
      return { invoiceSeries: [{ id: seriesId }] };
    }
  }))).post("/api/admin/v1/taxes/invoice-series")
    .set("authorization", `Bearer ${token}`)
    .send({ registrationId, documentType: "tax_invoice", financialYear: "2026-27",
      prefix: "inv/", nextNumber: 1, numberPadding: 6 });
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.documentType, "TAX_INVOICE");
  assert.equal(received.input.prefix, "INV/");
});

test("invoice series rejects a malformed financial year", async () => {
  const response = await request(app()).post("/api/admin/v1/taxes/invoice-series")
    .set("authorization", `Bearer ${token}`)
    .send({ registrationId, documentType: "TAX_INVOICE", financialYear: "2026-28",
      prefix: "INV/", nextNumber: 1, numberPadding: 6 });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "VALIDATION_FAILED");
  assert.equal(response.body.error.details[0].field, "");
});

test("invoice series update forwards optimistic version", async () => {
  let received;
  const response = await request(app(service({
    async updateInvoiceSeries(receivedTenantId, receivedSeriesId, input) {
      received = { receivedTenantId, receivedSeriesId, input };
      return { invoiceSeries: [{ id: seriesId, version: input.version + 1 }] };
    }
  }))).patch(`/api/admin/v1/taxes/invoice-series/${seriesId}`)
    .set("authorization", `Bearer ${token}`)
    .send({ registrationId, documentType: "CREDIT_NOTE", financialYear: "2026-27",
      prefix: "CN/", nextNumber: 4, numberPadding: 5, version: 2 });
  assert.equal(response.status, 200);
  assert.equal(received.receivedSeriesId, seriesId);
  assert.equal(received.input.version, 2);
});

test("tax invoice issuance forwards a tenant-scoped document date", async () => {
  let received;
  const response = await request(app(service({
    async issueTaxInvoice(receivedTenantId, input) {
      received = { receivedTenantId, input };
      return { taxDocuments: [{ documentNumber: "INV/000001" }], invoiceCandidates: [] };
    }
  }))).post("/api/admin/v1/taxes/documents")
    .set("authorization", `Bearer ${token}`)
    .send({ sellerOrderId, seriesId, documentDate: "2026-10-16" });
  assert.equal(response.status, 201);
  assert.equal(received.receivedTenantId, tenantId);
  assert.equal(received.input.sellerOrderId, sellerOrderId);
  assert.equal(received.input.documentDate, "2026-10-16");
});

test("issued tax document detail is tenant scoped", async () => {
  let received;
  const response = await request(app(service({
    async getTaxDocument(receivedTenantId, receivedDocumentId) {
      received = { receivedTenantId, receivedDocumentId };
      return { id: documentId, documentNumber: "INV/000001" };
    }
  }))).get(`/api/admin/v1/taxes/documents/${documentId}`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.deepEqual(received, { receivedTenantId: tenantId, receivedDocumentId: documentId });
  assert.equal(response.body.data.documentNumber, "INV/000001");
});

test("issued tax document PDF is returned as a private attachment", async () => {
  const response = await request(app()).get(`/api/admin/v1/taxes/documents/${documentId}/pdf`)
    .set("authorization", `Bearer ${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/pdf");
  assert.match(response.headers["content-disposition"], /^attachment;/);
  assert.equal(response.headers["cache-control"], "private, no-store");
});
