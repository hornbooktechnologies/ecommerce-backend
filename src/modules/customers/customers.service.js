import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./customers.dao.js";

function notFound() {
  return new AppError({ code: "CUSTOMER_NOT_FOUND", message: "The customer was not found.", status: 404 });
}

export function createCustomersService({ dao = defaultDao, transaction = withTransaction } = {}) {
  async function listCustomers(tenantId, filters) {
    return dao.listCustomers({ tenantId, filters });
  }

  async function getCustomer(tenantId, customerId) {
    const details = await dao.getCustomerDetails({ tenantId, customerId });
    if (!details) throw notFound();
    return details;
  }

  async function updateCustomer(tenantId, customerId, input, context) {
    await transaction(tenantId, async (connection) => {
      const current = await dao.getCustomer({ tenantId, customerId, connection, forUpdate: true });
      if (!current) throw notFound();
      if (!await dao.updateCustomer({ tenantId, customerId, input, connection })) throw notFound();
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "CUSTOMER_UPDATED", entityId: customerId, requestId: context.requestId,
        ipAddress: context.ipAddress || "127.0.0.1", userAgent: context.userAgent,
        beforeData: { firstName: current.firstName, lastName: current.lastName,
          email: current.email, phone: current.phone, type: current.type,
          companyName: current.companyName, gstin: current.gstin, status: current.status,
          notes: current.notes }, afterData: input }, connection });
    });
    return getCustomer(tenantId, customerId);
  }

  return { listCustomers, getCustomer, updateCustomer };
}

const service = createCustomersService();
export const { listCustomers, getCustomer, updateCustomer } = service;
