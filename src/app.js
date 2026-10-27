import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFound } from "./middleware/not-found.js";
import { requestContext } from "./middleware/request-context.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import { createHealthRouter } from "./modules/health/health.routes.js";
import { createPlatformTenantRouter } from "./modules/platform-tenants/platform-tenants.routes.js";
import { createPlatformAccessRouter } from "./modules/platform-access/platform-access.routes.js";
import { createAccessControlRouter } from "./modules/access-control/access-control.routes.js";
import { createCatalogRouter } from "./modules/catalog/catalog.routes.js";
import { createInventoryRouter } from "./modules/inventory/inventory.routes.js";
import { createOrdersRouter } from "./modules/orders/orders.routes.js";
import { createReturnsRouter } from "./modules/returns/returns.routes.js";
import { createVendorsRouter } from "./modules/vendors/vendors.routes.js";
import { createVendorPortalRouter } from "./modules/vendor-portal/vendor-portal.routes.js";
import { createStoreOperationsRouter } from "./modules/store-operations/store-operations.routes.js";
import { createDashboardRouter } from "./modules/dashboard/dashboard.routes.js";
import { createWarrantiesRouter } from "./modules/warranties/warranties.routes.js";
import { createTaxesRouter } from "./modules/taxes/taxes.routes.js";
import { createCustomersRouter } from "./modules/customers/customers.routes.js";
import { createPromotionsRouter } from "./modules/promotions/promotions.routes.js";
import { createOffersRouter } from "./modules/offers/offers.routes.js";
import { createProcurementRouter } from "./modules/procurement/procurement.routes.js";
import { createBulkOperationsRouter } from "./modules/bulk-operations/bulk-operations.routes.js";
import { createSubstitutionsRouter } from "./modules/substitutions/substitutions.routes.js";
import { createBundlesRouter } from "./modules/bundles/bundles.routes.js";
import { createMarketplaceFinanceRouter } from "./modules/marketplace-finance/marketplace-finance.routes.js";
import { createReportsRouter } from "./modules/reports/reports.routes.js";
import { createRatingsRouter } from "./modules/ratings/ratings.routes.js";
import { createStorefrontRouter } from "./modules/storefront/storefront.routes.js";
import { createStorefrontWishlistRouter } from "./modules/storefront-wishlist/storefront-wishlist.routes.js";
import { createHomepageRouter } from "./modules/homepage/homepage.routes.js";
import { createCustomerAccountsRouter } from "./modules/customer-accounts/customer-accounts.routes.js";
import { createStorefrontCartRouter } from "./modules/storefront-cart/storefront-cart.routes.js";
import { createStorefrontCheckoutRouter } from "./modules/storefront-checkout/storefront-checkout.routes.js";
import { createPaymentsRouter } from "./modules/payments/payments.routes.js";

export function createApp({
  readinessCheck,
  authenticationService,
  platformTenantService,
  platformAccessService,
  platformAccessAuthorization,
  platformAuthorization,
  accessControlService,
  catalogService,
  inventoryService,
  storeOperationsService,
  dashboardService,
  ordersService,
  returnsService,
  warrantiesService,
  taxesService,
  customersService,
  promotionsService,
  offersService,
  procurementService,
  bulkOperationsService,
  substitutionsService,
  bundlesService,
  marketplaceFinanceService,
  reportsService,
  ratingsService,
  storefrontService,
  homepageService,
  homepageSectionsService,
  customerAccountsService,
  storefrontCartService,
  storefrontWishlistService,
  storefrontCheckoutService,
  paymentsService,
  vendorsService,
  vendorPortalService,
  vendorAccessResolver,
  vendorPermissionAuthorization,
  tenantAccessResolver,
  tenantPermissionAuthorization
} = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(pinoHttp({ logger, customProps: (req) => ({ requestId: req.context?.requestId }) }));
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || env.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true
  }));
  app.use("/media/product-media", express.static(env.productMediaDirectory, {
    dotfiles: "deny",
    fallthrough: true,
    immutable: env.nodeEnv === "production",
    maxAge: env.nodeEnv === "production" ? "30d" : 0,
    setHeaders(response) {
      response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    }
  }));
  app.use("/media/vendor-logos", express.static(env.vendorLogoDirectory, {
    dotfiles: "deny",
    fallthrough: true,
    immutable: env.nodeEnv === "production",
    maxAge: env.nodeEnv === "production" ? "30d" : 0,
    setHeaders(response) {
      response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    }
  }));
  // CSV imports are staged as JSON text until object storage is selected.
  app.use(express.json({ limit: "6mb" }));

  app.use("/health", createHealthRouter({ readinessCheck }));
  app.use("/api/storefront/v1", createStorefrontRouter({ service: storefrontService }));
  app.use("/api/storefront/v1", createCustomerAccountsRouter({ service: customerAccountsService }));
  app.use("/api/storefront/v1", createStorefrontCartRouter({ service: storefrontCartService }));
  app.use("/api/storefront/v1", createStorefrontWishlistRouter({ service: storefrontWishlistService }));
  app.use("/api/storefront/v1", createStorefrontCheckoutRouter({ service: storefrontCheckoutService }));
  app.use("/api/admin/v1/auth", createAuthRouter({ authenticationService }));
  app.use("/api/admin/v1", createPaymentsRouter({ service: paymentsService, resolveTenant: tenantAccessResolver }));
  app.use("/api/admin/v1", createHomepageRouter({ service: homepageService, sectionsService: homepageSectionsService,
    resolveTenant: tenantAccessResolver, authorize: tenantPermissionAuthorization }));
  app.use("/api/platform/v1/tenants", createPlatformTenantRouter({
    tenantService: platformTenantService,
    authorizePlatform: platformAuthorization
  }));
  app.use("/api/admin/v1", createAccessControlRouter({
    accessControlService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createDashboardRouter({
    dashboardService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createCatalogRouter({
    catalogService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createSubstitutionsRouter({
    substitutionsService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createBundlesRouter({
    bundlesService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createInventoryRouter({
    inventoryService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createStoreOperationsRouter({
    storeOperationsService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createOrdersRouter({
    ordersService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createCustomersRouter({
    customersService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createPromotionsRouter({
    promotionsService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createOffersRouter({
    offersService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createProcurementRouter({
    procurementService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createBulkOperationsRouter({
    bulkOperationsService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createReturnsRouter({
    returnsService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createWarrantiesRouter({
    warrantiesService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createTaxesRouter({
    taxesService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createVendorsRouter({
    vendorsService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createMarketplaceFinanceRouter({
    marketplaceFinanceService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/platform/v1/access", createPlatformAccessRouter({
    platformAccessService,
    authorize: platformAccessAuthorization
  }));
  app.use("/api/admin/v1", createReportsRouter({
    reportsService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/admin/v1", createRatingsRouter({
    ratingsService,
    resolveTenant: tenantAccessResolver,
    authorize: tenantPermissionAuthorization
  }));
  app.use("/api/vendor/v1", createVendorPortalRouter({ vendorPortalService,
    resolveVendor: vendorAccessResolver, authorize: vendorPermissionAuthorization }));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
