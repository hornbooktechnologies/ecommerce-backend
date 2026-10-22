import assert from "node:assert/strict";
import test from "node:test";
import { createCustomersService } from "../src/modules/customers/customers.service.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b88";
const customerId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b66";
const actorUserId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b77";

test("missing customer profiles return a tenant-safe not found error", async () => {
  const service = createCustomersService({ dao: { async getCustomerDetails() { return null; } } });
  await assert.rejects(() => service.getCustomer(tenantId, customerId),
    (error) => error.code === "CUSTOMER_NOT_FOUND" && error.status === 404);
});

test("customer updates are transactional and audited", async () => {
  let audit;
  const input = { firstName: "Asha", lastName: "Rao", email: "asha@example.in", phone: "",
    type: "INDIVIDUAL", companyName: "", gstin: "", status: "ACTIVE", notes: "Priority" };
  const dao = {
    async getCustomer({ forUpdate }) {
      return forUpdate ? { id: customerId, firstName: "Old", lastName: "Name", email: "old@example.in",
        phone: "", type: "INDIVIDUAL", companyName: "", gstin: "", status: "ACTIVE", notes: "" }
        : { id: customerId, ...input };
    },
    async updateCustomer() { return true; },
    async insertAudit(value) { audit = value.audit; },
    async getCustomerDetails() { return { customer: { id: customerId, ...input }, addresses: [], orders: [], returns: [], warranties: [] }; }
  };
  const transaction = async (_tenantId, operation) => operation({});
  const service = createCustomersService({ dao, transaction });
  const result = await service.updateCustomer(tenantId, customerId, input,
    { actorUserId, requestId: "customer-test", ipAddress: "127.0.0.1", userAgent: "test" });
  assert.equal(result.customer.firstName, "Asha");
  assert.equal(audit.action, "CUSTOMER_UPDATED");
  assert.equal(audit.entityId, customerId);
  assert.equal(audit.beforeData.firstName, "Old");
  assert.equal(audit.afterData.notes, "Priority");
});
