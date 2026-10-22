import assert from "node:assert/strict";
import test from "node:test";
import { buildUiConfiguration } from "../src/modules/auth/ui-configuration.js";

const tenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b79";

test("UI configuration filters tenant navigation from role capabilities", () => {
  const ui = buildUiConfiguration([{
    roleLevel: "TENANT", roleKey: "catalog_manager", tenantId,
    permissions: ["dashboard.read", "catalog.product.read", "catalog.product.update"]
  }]);

  assert.deepEqual(ui.navigation.admin[tenantId].map((item) => item.label), ["Overview", "Catalog"]);
  assert.deepEqual(ui.capabilities.admin[tenantId], [
    "catalog.product.read", "catalog.product.update", "dashboard.read"
  ]);
});

test("UI configuration keeps permissions isolated between tenant contexts", () => {
  const secondTenantId = "018f47f2-6b6d-7c34-ae31-8f4f17b79b80";
  const ui = buildUiConfiguration([
    { roleLevel: "TENANT", roleKey: "catalog_manager", tenantId, permissions: ["catalog.product.read"] },
    { roleLevel: "TENANT", roleKey: "inventory_manager", tenantId: secondTenantId, permissions: ["inventory.stock.read"] }
  ]);

  assert.deepEqual(ui.navigation.admin[tenantId].map((item) => item.label), ["Catalog"]);
  assert.deepEqual(ui.navigation.admin[secondTenantId].map((item) => item.label), ["Inventory"]);
});

test("tax navigation appears only when the API grants tax access", () => {
  const ui = buildUiConfiguration([{
    roleLevel: "TENANT", roleKey: "tenant_administrator", tenantId,
    permissions: ["dashboard.read", "tax.read", "tax.manage"]
  }]);
  assert.deepEqual(ui.navigation.admin[tenantId].map((item) => item.href), ["/admin", "/admin/settings/taxes"]);
  assert.equal(ui.capabilities.admin[tenantId].includes("tax.manage"), true);
});

test("seller pricing navigation appears only when offer access is granted", () => {
  const ui = buildUiConfiguration([{
    roleLevel: "TENANT", roleKey: "catalog_manager", tenantId,
    permissions: ["catalog.offer.read", "catalog.offer.manage"]
  }]);
  assert.deepEqual(ui.navigation.admin[tenantId].map((item) => item.href), ["/admin/offers"]);
  assert.equal(ui.capabilities.admin[tenantId].includes("catalog.offer.manage"), true);
});

test("procurement navigation appears only when supplier and purchase-order access is granted", () => {
  const ui = buildUiConfiguration([{
    roleLevel: "TENANT", roleKey: "inventory_manager", tenantId,
    permissions: ["inventory.stock.read", "procurement.read", "procurement.manage"]
  }]);
  assert.deepEqual(ui.navigation.admin[tenantId].map((item) => item.href), ["/admin/inventory", "/admin/procurement"]);
  assert.equal(ui.capabilities.admin[tenantId].includes("procurement.manage"), true);
});

test("UI configuration exposes only implemented modules even when more permissions exist", () => {
  const ui = buildUiConfiguration([
    {
      roleLevel: "PLATFORM", roleKey: "platform_super_admin", tenantId: null,
      permissions: ["*"]
    },
    {
      roleLevel: "TENANT", roleKey: "tenant_owner", tenantId,
      permissions: [
        "dashboard.read", "catalog.product.read", "inventory.stock.read",
        "order.read", "vendor.read", "return.read", "marketplace.settlement.read",
        "report.sales.read", "settings.store.read", "settings.user.read", "settings.role.read"
      ]
    },
    {
      roleLevel: "VENDOR", roleKey: "vendor_owner", tenantId,
      permissions: [
        "vendor.dashboard.read", "vendor.catalog.read", "vendor.offer.read",
        "vendor.inventory.read", "vendor.order.read", "vendor.return.read",
        "vendor.finance.read", "vendor.profile.read"
      ]
    }
  ]);

  assert.deepEqual(ui.navigation.platform.map((item) => item.href), [
    "/platform", "/platform/tenants"
  ]);
  assert.deepEqual(ui.navigation.admin[tenantId].map((item) => item.href), [
    "/admin", "/admin/orders", "/admin/returns", "/admin/catalog/products", "/admin/inventory", "/admin/stores",
    "/admin/vendors", "/admin/finance", "/admin/settings/users", "/admin/settings/roles"
  ]);
  assert.deepEqual(ui.navigation.vendor[tenantId].map((item) => item.href), [
    "/vendor", "/vendor/orders"
  ]);
});

test("marketplace finance navigation appears only with settlement read access", () => {
  const ui = buildUiConfiguration([{
    roleLevel: "TENANT", roleKey: "finance_manager", tenantId,
    permissions: ["marketplace.settlement.read", "marketplace.settlement.manage"]
  }]);
  assert.deepEqual(ui.navigation.admin[tenantId].map((item) => item.href), ["/admin/finance"]);
  assert.equal(ui.capabilities.admin[tenantId].includes("marketplace.settlement.manage"), true);
});
