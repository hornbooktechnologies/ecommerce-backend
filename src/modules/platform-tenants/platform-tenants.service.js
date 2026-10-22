import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { hashPassword } from "../../core/security/password.js";
import { withTransaction } from "../../database/transaction.js";
import { catalogVerticals } from "../catalog/catalog-verticals.js";
import * as defaultTenantDao from "./platform-tenants.dao.js";

const roleTemplates = [
  ["tenant_owner", "Tenant owner", "TENANT"],
  ["tenant_administrator", "Tenant administrator", "TENANT"],
  ["catalog_manager", "Catalog manager", "TENANT"],
  ["inventory_manager", "Inventory manager", "TENANT"],
  ["order_manager", "Order manager", "TENANT"],
  ["vendor_manager", "Vendor manager", "TENANT"],
  ["finance_manager", "Finance manager", "TENANT"],
  ["analyst", "Analyst", "TENANT"],
  ["auditor", "Auditor", "TENANT"],
  ["vendor_owner", "Vendor owner", "VENDOR"],
  ["vendor_catalog_manager", "Vendor catalog manager", "VENDOR"]
];

const rolePermissions = {
  tenant_owner: "ALL",
  tenant_administrator: "ALL",
  catalog_manager: ["dashboard.read", "catalog.product.read", "catalog.product.create", "catalog.product.update", "catalog.product.approve", "catalog.offer.read", "catalog.offer.manage", "promotion.read", "promotion.manage"],
  inventory_manager: ["dashboard.read", "inventory.stock.read", "inventory.stock.manage"],
  order_manager: ["dashboard.read", "order.read", "order.create", "order.manage", "customer.read", "customer.manage", "promotion.read", "promotion.manage", "return.read", "return.manage"],
  vendor_manager: ["dashboard.read", "vendor.read", "vendor.manage", "catalog.offer.read", "catalog.offer.manage"],
  finance_manager: ["dashboard.read", "marketplace.settlement.read", "marketplace.settlement.manage", "report.sales.read"],
  analyst: ["dashboard.read", "order.read", "customer.read", "promotion.read", "catalog.product.read", "inventory.stock.read", "vendor.read", "return.read", "marketplace.settlement.read", "report.sales.read"],
  auditor: ["dashboard.read", "order.read", "customer.read", "promotion.read", "catalog.product.read", "inventory.stock.read", "vendor.read", "return.read", "marketplace.settlement.read", "report.sales.read", "audit.read"],
  vendor_owner: ["vendor.dashboard.read", "vendor.profile.read", "vendor.profile.update",
    "vendor.catalog.read", "vendor.offer.read", "vendor.offer.update", "vendor.order.read",
    "vendor.order.manage", "vendor.fulfillment.read", "vendor.fulfillment.manage"],
  vendor_catalog_manager: ["vendor.dashboard.read", "vendor.profile.read", "vendor.catalog.read",
    "vendor.offer.read", "vendor.offer.update"]
};

const sequenceTemplates = [
  ["ORDER", "ORD"],
  ["SELLER_ORDER", "SO"],
  ["RETURN", "RET"],
  ["PURCHASE_ORDER", "PO"],
  ["TRANSFER", "TRF"],
  ["WARRANTY_CLAIM", "WC"],
  ["SETTLEMENT", "STL"],
  ["PAYOUT", "PAY"]
];

function notFound() {
  return new AppError({
    code: "TENANT_NOT_FOUND",
    message: "The tenant could not be found.",
    status: 404
  });
}

function duplicateCode() {
  return new AppError({
    code: "TENANT_CODE_EXISTS",
    message: "This tenant code is already in use.",
    status: 409,
    details: [{ field: "code", code: "unique", message: "Choose a different tenant code." }]
  });
}

function invalidTransition(current, requested) {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message: `A ${current.toLowerCase()} tenant cannot be changed to ${requested.toLowerCase()}.`,
    status: 409
  });
}

function verticalInUse(verticals) {
  const labels = new Map(catalogVerticals.map((item) => [item.code, item.label]));
  const names = verticals.map((vertical) => labels.get(vertical) || vertical).join(", ");
  return new AppError({
    code: "PRODUCT_TYPE_IN_USE",
    message: `${names} cannot be disabled because products already use ${verticals.length === 1 ? "this type" : "these types"}.`,
    status: 409,
    details: verticals.map((vertical) => ({
      field: "catalogVerticals",
      code: "in_use",
      message: `${labels.get(vertical) || vertical} is used by existing products.`
    }))
  });
}

function requestAudit(context) {
  return {
    actorUserId: context.actorUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress || null,
    userAgent: context.userAgent?.slice(0, 500) || null
  };
}

function idsForProvisioning() {
  const roles = roleTemplates.map(([key, name, level]) => ({ id: createId(), key, name, level }));
  return {
    tenantId: createId(),
    userId: createId(),
    storeId: createId(),
    channelId: createId(),
    merchantId: createId(),
    membershipId: createId(),
    assignmentId: createId(),
    roles,
    sequences: sequenceTemplates.map(([type, shortCode]) => ({ id: createId(), type, shortCode }))
  };
}

function mutationRecords({ tenantId, actor, action, beforeData, afterData, metadata, eventType }) {
  return {
    audit: {
      id: createId(),
      tenantId,
      entityId: tenantId,
      ...actor,
      action,
      beforeData,
      afterData,
      metadata
    },
    event: {
      id: createId(),
      tenantId,
      aggregateId: tenantId,
      type: eventType,
      payload: { tenantId, ...afterData, ...(metadata ? { metadata } : {}) }
    }
  };
}

function handleWriteError(error) {
  if (error?.code === "ER_DUP_ENTRY") {
    throw duplicateCode();
  }
  throw error;
}

export function createPlatformTenantService({
  tenantDao = defaultTenantDao,
  transaction = withTransaction,
  passwordHasher = hashPassword
} = {}) {
  async function getTenant(tenantId) {
    const tenant = await tenantDao.findTenantById({ tenantId });
    if (!tenant) {
      throw notFound();
    }

    const [stores, merchants, owner, activity, catalogVerticals] = await Promise.all([
      tenantDao.listTenantStores({ tenantId }),
      tenantDao.listTenantMerchants({ tenantId }),
      tenantDao.findTenantOwner({ tenantId }),
      tenantDao.listTenantAudit({ tenantId }),
      tenantDao.listTenantProductVerticals({ tenantId })
    ]);
    return { ...tenant, catalogVerticals, stores, merchants, owner, activity };
  }

  async function listTenants(input) {
    const [result, summary] = await Promise.all([
      tenantDao.listTenants(input),
      tenantDao.summarizeTenants()
    ]);
    return {
      ...result,
      page: input.page,
      pageSize: input.pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / input.pageSize)),
      summary
    };
  }

  async function createTenant(input, context) {
    const ids = idsForProvisioning();
    const passwordHash = await passwordHasher(input.owner.temporaryPassword);
    const code = input.code.toUpperCase();
    const storeCode = input.defaultStore.code.toUpperCase();
    const sequencePrefix = code.slice(0, 12);

    try {
      const tenantId = await transaction(null, async (connection) => {
        if (await tenantDao.findTenantByCode({ code, connection })) {
          throw duplicateCode();
        }

        let owner = await tenantDao.findUserByEmail({ email: input.owner.email, connection });
        if (owner && owner.status !== "ACTIVE") {
          throw new AppError({
            code: "OWNER_ACCOUNT_UNAVAILABLE",
            message: "The owner email belongs to an account that is not active.",
            status: 409,
            details: [{ field: "owner.email", code: "account_unavailable", message: "Use an active account or another email." }]
          });
        }
        if (!owner) {
          owner = { id: ids.userId, ...input.owner, passwordHash };
          await tenantDao.insertUser({ user: owner, connection });
        }

        const tenant = {
          id: ids.tenantId,
          code,
          legalName: input.legalName,
          displayName: input.displayName,
          defaultCurrency: input.defaultCurrency,
          defaultLanguage: input.defaultLanguage,
          timezone: input.timezone
        };
        await tenantDao.insertTenant({ tenant, connection });
        await tenantDao.insertTenantProductVerticals({
          tenantId: tenant.id,
          verticals: input.catalogVerticals,
          enabledBy: context.actorUserId,
          connection
        });

        const store = {
          id: ids.storeId,
          tenantId: tenant.id,
          code: storeCode,
          name: input.defaultStore.name,
          legalName: input.legalName,
          baseCurrency: input.defaultCurrency,
          languageCode: input.defaultLanguage,
          timezone: input.timezone,
          supportEmail: input.defaultStore.supportEmail || null,
          supportPhone: input.defaultStore.supportPhone || null
        };
        await tenantDao.insertStore({ store, connection });
        await tenantDao.insertSalesChannel({
          channel: {
            id: ids.channelId,
            tenantId: tenant.id,
            storeId: store.id,
            code: "ADMIN",
            name: "Admin operations",
            configuration: { orderEntryEnabled: true }
          },
          connection
        });

        await tenantDao.insertMerchant({
          merchant: {
            id: ids.merchantId,
            tenantId: tenant.id,
            code: "FIRST_PARTY",
            displayName: input.displayName,
            legalName: input.legalName,
            supportEmail: store.supportEmail,
            supportPhone: store.supportPhone,
            approvedBy: context.actorUserId
          },
          connection
        });
        await tenantDao.linkStoreMerchant({ storeId: store.id, merchantId: ids.merchantId, connection });

        for (const role of ids.roles) {
          await tenantDao.insertRole({ role: { ...role, tenantId: tenant.id }, connection });
          await tenantDao.insertRolePermissions({
            roleId: role.id,
            permissionKeys: rolePermissions[role.key] || [],
            connection
          });
        }
        const ownerRole = ids.roles.find((role) => role.key === "tenant_owner");
        await tenantDao.insertMembership({
          membership: {
            id: ids.membershipId,
            tenantId: tenant.id,
            userId: owner.id,
            invitedBy: context.actorUserId
          },
          connection
        });
        await tenantDao.insertRoleAssignment({
          assignment: {
            id: ids.assignmentId,
            userId: owner.id,
            tenantId: tenant.id,
            roleId: ownerRole.id,
            assignedBy: context.actorUserId
          },
          connection
        });

        for (const sequence of ids.sequences) {
          await tenantDao.insertNumberSequence({
            sequence: {
              ...sequence,
              tenantId: tenant.id,
              storeId: store.id,
              prefix: `${sequencePrefix}-${sequence.shortCode}-`
            },
            connection
          });
        }

        const records = mutationRecords({
          tenantId: tenant.id,
          actor: requestAudit(context),
          action: "platform.tenant.created",
          beforeData: null,
          afterData: { code: tenant.code, displayName: tenant.displayName, status: "PENDING",
            catalogVerticals: input.catalogVerticals },
          metadata: { storeId: store.id, merchantId: ids.merchantId, ownerUserId: owner.id },
          eventType: "tenant.created"
        });
        await tenantDao.insertAuditLog({ audit: records.audit, connection });
        await tenantDao.insertOutboxEvent({ event: records.event, connection });
        return tenant.id;
      });

      return getTenant(tenantId);
    } catch (error) {
      return handleWriteError(error);
    }
  }

  async function updateTenant(tenantId, changes, context) {
    try {
      await transaction(tenantId, async (connection) => {
        const current = await tenantDao.findTenantById({ tenantId, connection, forUpdate: true });
        if (!current) {
          throw notFound();
        }
        const currentVerticals = await tenantDao.listTenantProductVerticals({
          tenantId, connection, forUpdate: true
        });
        const nextVerticals = changes.catalogVerticals || currentVerticals;
        const removedVerticals = currentVerticals.filter((vertical) => !nextVerticals.includes(vertical));
        if (removedVerticals.length) {
          const usage = await tenantDao.countProductsByVerticals({
            tenantId, verticals: removedVerticals, connection
          });
          const usedVerticals = usage.filter((item) => item.productCount > 0).map((item) => item.vertical);
          if (usedVerticals.length) throw verticalInUse(usedVerticals);
        }
        await tenantDao.updateTenantDetails({ tenantId, changes, connection });
        if (changes.catalogVerticals) {
          await tenantDao.replaceTenantProductVerticals({
            tenantId,
            verticals: changes.catalogVerticals,
            enabledBy: context.actorUserId,
            connection
          });
        }
        const afterData = {
          legalName: changes.legalName ?? current.legalName,
          displayName: changes.displayName ?? current.displayName,
          timezone: changes.timezone ?? current.timezone,
          catalogVerticals: nextVerticals
        };
        const records = mutationRecords({
          tenantId,
          actor: requestAudit(context),
          action: "platform.tenant.updated",
          beforeData: { legalName: current.legalName, displayName: current.displayName,
            timezone: current.timezone, catalogVerticals: currentVerticals },
          afterData,
          eventType: "tenant.updated"
        });
        await tenantDao.insertAuditLog({ audit: records.audit, connection });
        await tenantDao.insertOutboxEvent({ event: records.event, connection });
      });
      return getTenant(tenantId);
    } catch (error) {
      return handleWriteError(error);
    }
  }

  async function transitionTenant(tenantId, action, reason, context) {
    const transitions = {
      activate: { from: ["PENDING"], to: "ACTIVE", past: "activated" },
      suspend: { from: ["ACTIVE"], to: "SUSPENDED", past: "suspended" },
      restore: { from: ["SUSPENDED"], to: "ACTIVE", past: "restored" }
    };
    const transition = transitions[action];

    await transaction(tenantId, async (connection) => {
      const current = await tenantDao.findTenantById({ tenantId, connection, forUpdate: true });
      if (!current) {
        throw notFound();
      }
      if (!transition.from.includes(current.status)) {
        throw invalidTransition(current.status, transition.to);
      }

      await tenantDao.updateTenantStatus({
        tenantId,
        status: transition.to,
        reason,
        connection
      });
      const records = mutationRecords({
        tenantId,
        actor: requestAudit(context),
        action: `platform.tenant.${transition.past}`,
        beforeData: { status: current.status },
        afterData: { status: transition.to },
        metadata: { reason },
        eventType: `tenant.${transition.past}`
      });
      await tenantDao.insertAuditLog({ audit: records.audit, connection });
      await tenantDao.insertOutboxEvent({ event: records.event, connection });
    });

    return getTenant(tenantId);
  }

  return {
    listTenants,
    getTenant,
    createTenant,
    updateTenant,
    activateTenant: (tenantId, reason, context) => transitionTenant(tenantId, "activate", reason, context),
    suspendTenant: (tenantId, reason, context) => transitionTenant(tenantId, "suspend", reason, context),
    restoreTenant: (tenantId, reason, context) => transitionTenant(tenantId, "restore", reason, context)
  };
}

const service = createPlatformTenantService();

export const listTenants = service.listTenants;
export const getTenant = service.getTenant;
export const createTenant = service.createTenant;
export const updateTenant = service.updateTenant;
export const activateTenant = service.activateTenant;
export const suspendTenant = service.suspendTenant;
export const restoreTenant = service.restoreTenant;
