import * as defaultDao from "./inbox.dao.js";

const lifecycle = Object.freeze({
  "platform.tenant.created": {
    from: null, to: "PENDING", kind: "TENANT_CREATED", title: "Tenant created",
    message: "A tenant was created and is awaiting activation. Review its setup before activating it."
  },
  "platform.tenant.activated": {
    from: "PENDING", to: "ACTIVE", kind: "TENANT_ACTIVATED", title: "Tenant activated",
    message: "Tenant activation was recorded. Activation does not confirm that products, stock or storefront setup are complete."
  },
  "platform.tenant.suspended": {
    from: "ACTIVE", to: "SUSPENDED", kind: "TENANT_SUSPENDED", title: "Tenant suspended",
    message: "Tenant suspension was recorded. Open the tenant to review its current status and audit history."
  },
  "platform.tenant.restored": {
    from: "SUSPENDED", to: "ACTIVE", kind: "TENANT_RESTORED", title: "Tenant restored",
    message: "The tenant was restored from suspension. Open the tenant to review its current status and remaining operational setup."
  }
});

export function createPlatformTenantInboxEvents({ dao = defaultDao } = {}) {
  return async function enqueuePlatformTenantInbox({ tenantId, auditId, connection }) {
    const source = await dao.sourcePlatformTenantEvent({ tenantId, auditId, connection });
    if (!source || !Object.hasOwn(lifecycle, source.action)) return;
    const event = lifecycle[source.action];
    if (source.status !== event.to || source.previousStatus !== event.from) return;
    const permission = "platform.tenant.read";
    const recipients = await dao.platformRecipients({ permission, connection });
    if (!recipients.length) return;
    const code = String(source.code || tenantId).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0,100);
    await dao.enqueue({ event: {
      tenantId, audience: "PLATFORM", permission, recipients,
      key: `PLATFORM_TENANT:${auditId}:PLATFORM`,
      kind: event.kind, category: "TENANTS", entityType: "TENANT", entityId: tenantId,
      title: event.title, message: `Tenant ${code}. ${event.message}`
    }, connection });
  };
}

export const enqueuePlatformTenantInbox = createPlatformTenantInboxEvents();
