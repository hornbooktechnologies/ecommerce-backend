import { resolveAppearance } from '../../config/appearance/appearance.js';

// Keep routes and capabilities attached to the same menu entry. The array defines display order.
function section(id, label, order, items) {
  return items.map((item) => ({ ...item, group: { id, label, order } }));
}

const navigationCatalog = {
  platform: [
    { id: "platform", label: "Dashboard", href: "/platform", icon: "overview", capability: "platform.dashboard.read" },
    { id: "tenants", label: "Businesses (tenants)", href: "/platform/tenants", icon: "tenants", capability: "platform.tenant.read", matchPrefix: "/platform/tenants" },
    { id: "team", label: "Platform team", href: "/platform/team", icon: "users", capability: "platform.user.read", matchPrefix: "/platform/team" },
    { id: "notification-deliveries", label: "Notification deliveries", href: "/platform/notification-deliveries", icon: "jobs", capability: "platform.notification.read" },
    { id: "platform-audit", label: "Platform audit log", href: "/platform/audit-log", icon: "audit", capability: "platform.audit.read" }
  ],
  admin: [
    { id: "admin", label: "Dashboard", href: "/admin", icon: "overview", capability: "dashboard.read", pinned: true },
    ...section("setup", "Set up your store", 1, [
      { id: "stores", label: "Stores", href: "/admin/stores", icon: "stores", capability: "settings.store.read" },
      { id: "taxes", label: "Tax settings", href: "/admin/settings/taxes", icon: "taxes", capability: "tax.read" },
      { id: "users", label: "Team members", href: "/admin/settings/users", icon: "users", capability: "settings.user.read" },
      { id: "roles", label: "Roles & permissions", href: "/admin/settings/roles", icon: "access", capability: "settings.role.read" },
      { id: "vendors", label: "Marketplace sellers", href: "/admin/vendors", icon: "vendors", capability: "vendor.read" }
    ]),
    ...section("products", "Add products & prices", 2, [
      { id: "products", label: "Product catalog", href: "/admin/catalog/products", icon: "catalog", capability: "catalog.product.read", matchPrefix: "/admin/catalog" },
      { id: "offers", label: "Seller prices", href: "/admin/offers", icon: "offers", capability: "catalog.offer.read" },
      { id: "bulk-operations", label: "Bulk product & stock updates", href: "/admin/bulk-operations", icon: "bulk", capability: "bulk.read" }
    ]),
    ...section("stock", "Buy & stock products", 3, [
      { id: "procurement", label: "Purchase orders & suppliers", href: "/admin/procurement", icon: "procurement", capability: "procurement.read" },
      { id: "inventory", label: "Inventory & warehouses", href: "/admin/inventory", icon: "inventory", capability: "inventory.stock.read" }
    ]),
    ...section("storefront", "Manage your storefront", 4, [
      { id: "homepage", label: "Homepage", href: "/admin/homepage", icon: "homepage", capability: "settings.store.read" },
      { id: "store-pages", label: "Store pages", href: "/admin/store-pages", icon: "content", capability: "store.content.read" },
      { id: "promotions", label: "Promotions & coupons", href: "/admin/promotions", icon: "promotions", capability: "promotion.read" },
      { id: "newsletter", label: "Newsletter", href: "/admin/newsletter", icon: "newsletter", capability: "newsletter.read" },
      { id: "shopping-alerts", label: "Shopping alerts", href: "/admin/shopping-alerts", icon: "shopping", capability: "customer.read" }
    ]),
    ...section("orders", "Manage orders & customers", 5, [
      { id: "orders", label: "Orders", href: "/admin/orders", icon: "orders", capability: "order.read", shortcut: true },
      { id: "customers", label: "Customers", href: "/admin/customers", icon: "customers", capability: "customer.read" },
      { id: "returns", label: "Returns & exchanges", href: "/admin/returns", icon: "returns", capability: "return.read" },
      { id: "warranties", label: "Warranties", href: "/admin/warranties", icon: "warranties", capability: "warranty.read" },
      { id: "questions", label: "Product questions", href: "/admin/questions", icon: "questions", capability: "question.read" },
      { id: "ratings", label: "Ratings & reviews", href: "/admin/ratings", icon: "ratings", capability: "rating.read" }
    ]),
    ...section("performance", "Review business performance", 6, [
      { id: "reports", label: "Reports", href: "/admin/reports", icon: "reports", capability: "report.sales.read" },
      { id: "finance", label: "Marketplace finance", href: "/admin/finance", icon: "finance", capability: "marketplace.settlement.read" }
    ])
  ],
  vendor: [
    { id: "vendor", label: "Dashboard", href: "/vendor", icon: "overview", capability: "vendor.dashboard.read" },
    { id: "orders", label: "Orders", href: "/vendor/orders", icon: "orders", capability: "vendor.order.read" },
    { id: "questions", label: "Product questions", href: "/vendor/questions", icon: "questions", capability: "vendor.question.read" }
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
  return navigationCatalog[area].filter((item) => unrestricted || capabilities.includes(item.capability));
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
    appearance: {
      platform: resolveAppearance('admin'),
      admin: Object.fromEntries(Object.keys(admin.capabilities).map(tenantId => [tenantId, resolveAppearance('admin', tenantId)])),
      vendor: Object.fromEntries(Object.keys(vendor.capabilities).map(tenantId => [tenantId, resolveAppearance('admin', tenantId)]))
    },
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
