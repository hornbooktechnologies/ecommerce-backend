const navigationCatalog = {
  // Add an item only after its page and end-to-end workflow are implemented.
  // Permissions decide who may see an implemented item; they must not expose
  // placeholder modules that do not have a working destination yet.
  platform: [
    { label: "Overview", href: "/platform", icon: "overview", capability: "platform.dashboard.read" },
    { label: "Tenants", href: "/platform/tenants", matchPrefix: "/platform/tenants", icon: "tenants", capability: "platform.tenant.read" },
    { label: "Platform team", href: "/platform/team", matchPrefix: "/platform/team", icon: "users", capability: "platform.user.read" }
  ],
  admin: [
    { label: "Overview", href: "/admin", icon: "overview", capability: "dashboard.read" },
    { label: "Orders", href: "/admin/orders", icon: "orders", capability: "order.read" },
    { label: "Customers", href: "/admin/customers", icon: "customers", capability: "customer.read" },
    { label: "Offers & coupons", href: "/admin/promotions", icon: "promotions", capability: "promotion.read" },
    { label: "Returns", href: "/admin/returns", icon: "returns", capability: "return.read" },
    { label: "Warranties", href: "/admin/warranties", icon: "warranties", capability: "warranty.read" },
    { label: "Catalog", href: "/admin/catalog/products", matchPrefix: "/admin/catalog", icon: "catalog", capability: "catalog.product.read" },
    { label: "Product ratings", href: "/admin/ratings", icon: "ratings", capability: "rating.read" },
    { label: "Seller pricing", href: "/admin/offers", icon: "offers", capability: "catalog.offer.read" },
    { label: "Inventory", href: "/admin/inventory", icon: "inventory", capability: "inventory.stock.read" },
    { label: "Procurement", href: "/admin/procurement", icon: "procurement", capability: "procurement.read" },
    { label: "Bulk operations", href: "/admin/bulk-operations", icon: "bulk", capability: "bulk.read" },
    { label: "Stores", href: "/admin/stores", icon: "stores", capability: "settings.store.read" },
    { label: "Homepage", href: "/admin/homepage", icon: "homepage", capability: "settings.store.read" },
    { label: "Vendors", href: "/admin/vendors", icon: "vendors", capability: "vendor.read" },
    { label: "Finance", href: "/admin/finance", icon: "finance", capability: "marketplace.settlement.read" },
    { label: "Reports", href: "/admin/reports", icon: "reports", capability: "report.sales.read" },
    { label: "Taxes", href: "/admin/settings/taxes", icon: "taxes", capability: "tax.read" },
    { label: "Team access", href: "/admin/settings/users", icon: "users", capability: "settings.user.read" },
    { label: "Roles", href: "/admin/settings/roles", icon: "access", capability: "settings.role.read" }
  ],
  vendor: [
    { label: "Overview", href: "/vendor", icon: "overview", capability: "vendor.dashboard.read" },
    { label: "Orders", href: "/vendor/orders", icon: "orders", capability: "vendor.order.read" }
  ]
};

function assignmentsAtLevel(assignments, roleLevel, tenantId = null) {
  return assignments.filter((assignment) => assignment.roleLevel === roleLevel
    && (tenantId === null || assignment.tenantId === tenantId));
}

function permissionsFor(assignments) {
  return [...new Set(assignments.flatMap((assignment) => assignment.permissions || []))].sort();
}

function allowedNavigation(area, capabilities, unrestricted = false) {
  return navigationCatalog[area]
    .filter((item) => unrestricted || !item.capability || capabilities.includes(item.capability))
    .map((item) => ({ ...item }));
}

function tenantContexts(assignments, roleLevel, area) {
  const tenantIds = [...new Set(assignmentsAtLevel(assignments, roleLevel)
    .map((assignment) => assignment.tenantId).filter(Boolean))];
  const navigation = {};
  const capabilities = {};

  for (const tenantId of tenantIds) {
    const scopedAssignments = assignmentsAtLevel(assignments, roleLevel, tenantId);
    const scopedCapabilities = permissionsFor(scopedAssignments);
    capabilities[tenantId] = scopedCapabilities;
    navigation[tenantId] = allowedNavigation(area, scopedCapabilities);
  }
  return { navigation, capabilities };
}

export function buildUiConfiguration(assignments) {
  const platformAssignments = assignmentsAtLevel(assignments, "PLATFORM");
  const platformCapabilities = permissionsFor(platformAssignments);
  const platformUnrestricted = platformAssignments.some((assignment) => assignment.roleKey === "platform_super_admin");
  const admin = tenantContexts(assignments, "TENANT", "admin");
  const vendor = tenantContexts(assignments, "VENDOR", "vendor");

  return {
    navigation: {
      platform: allowedNavigation("platform", platformCapabilities, platformUnrestricted),
      admin: admin.navigation,
      vendor: vendor.navigation
    },
    capabilities: {
      platform: platformUnrestricted ? ["*"] : platformCapabilities,
      admin: admin.capabilities,
      vendor: vendor.capabilities
    }
  };
}
