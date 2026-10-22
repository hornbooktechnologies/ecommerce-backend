# ecommerce-api

JavaScript-only Express API for the multi-tenant e-commerce SaaS platform.

## Local setup

Install and start MariaDB 10.4 directly on your machine, then create an empty database and a dedicated application user. Update `.env` if your local credentials differ.

```sql
CREATE DATABASE ecommerce CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'ecommerce'@'localhost' IDENTIFIED BY 'ecommerce_local';
GRANT ALL PRIVILEGES ON ecommerce.* TO 'ecommerce'@'localhost';
```

```powershell
Copy-Item .env.example .env
npm install
npm run db:migrate
npm run dev
```

Create the first platform administrator with one-time shell variables. Do not store the administrator password in an environment file or source control.

```powershell
$env:PLATFORM_ADMIN_EMAIL="admin@example.com"
$env:PLATFORM_ADMIN_PASSWORD="use-a-long-unique-password"
$env:PLATFORM_ADMIN_FIRST_NAME="Platform"
$env:PLATFORM_ADMIN_LAST_NAME="Admin"
npm run seed:platform-admin
```

Endpoints:

- `GET /health/live`
- `GET /health/ready`
- `POST /api/admin/v1/auth/login`
- `POST /api/admin/v1/auth/refresh`
- `POST /api/admin/v1/auth/logout`
- `GET /api/admin/v1/auth/me`
- `GET /api/platform/v1/tenants`
- `POST /api/platform/v1/tenants`
- Tenant creation requires `catalogVerticals` with one or more of `GENERAL`, `GROCERY`, `ELECTRONICS`, or `CLOTHING`.
- `PATCH /api/platform/v1/tenants/:tenantId` can add product types or remove an unused type; types referenced by products cannot be disabled.
- `GET /api/platform/v1/tenants/:tenantId`
- `PATCH /api/platform/v1/tenants/:tenantId`
- `POST /api/platform/v1/tenants/:tenantId/activate`
- `POST /api/platform/v1/tenants/:tenantId/suspend`
- `POST /api/platform/v1/tenants/:tenantId/restore`
- `GET /api/admin/v1/taxes`
- `POST /api/admin/v1/taxes/registrations`
- `PATCH /api/admin/v1/taxes/registrations/:registrationId`
- `POST /api/admin/v1/taxes/categories`
- `PATCH /api/admin/v1/taxes/categories/:categoryId`
- `POST /api/admin/v1/taxes/categories/:categoryId/rates`
- `PATCH /api/admin/v1/taxes/rates/:rateId`
- `POST /api/admin/v1/taxes/invoice-series`
- `PATCH /api/admin/v1/taxes/invoice-series/:seriesId`
- `POST /api/admin/v1/taxes/documents`
- `GET /api/admin/v1/taxes/documents/:documentId`
- `GET /api/admin/v1/taxes/documents/:documentId/pdf`
- `GET /api/admin/v1/customers`
- `GET /api/admin/v1/customers/:customerId`
- `PATCH /api/admin/v1/customers/:customerId`
- `GET /api/admin/v1/promotions`
- `GET /api/admin/v1/promotions/options`
- `POST /api/admin/v1/promotions`
- `GET /api/admin/v1/promotions/:promotionId`
- `PATCH /api/admin/v1/promotions/:promotionId`
- `POST /api/admin/v1/promotions/:promotionId/activate`
- `POST /api/admin/v1/promotions/:promotionId/pause`
- `POST /api/admin/v1/promotions/:promotionId/preview`
- `POST /api/admin/v1/promotions/:promotionId/coupons`
- `PATCH /api/admin/v1/promotions/:promotionId/coupons/:couponId`
- `GET /api/admin/v1/offers` — tenant-wide first-party and vendor seller offers
- `GET /api/admin/v1/offers/options`
- `POST /api/admin/v1/offers`
- `GET /api/admin/v1/offers/:offerId`
- `PATCH /api/admin/v1/offers/:offerId`
- `GET /api/admin/v1/price-lists`
- `POST /api/admin/v1/price-lists`
- `PATCH /api/admin/v1/price-lists/:priceListId`
- `GET /api/admin/v1/inventory/traceability/lots` - paginated batch, expiry, and quarantine health
- `GET /api/admin/v1/inventory/traceability/serials` - paginated unit-level serial lifecycle directory
- `PATCH /api/admin/v1/inventory/traceability/serials/:serialId` - audited available/quarantine/scrap reconciliation
- `POST /api/admin/v1/inventory/transfers` - immediate quantity, batch, or exact serialized warehouse transfer
- `POST /api/admin/v1/auth/password/forgot`
- `POST /api/admin/v1/auth/password/reset`
- `PATCH /api/admin/v1/auth/password`

Password reset links are single-use and expire after 30 minutes. In development,
the forgot-password response includes `developmentResetUrl` so the flow can be
tested locally without an email provider. Production responses never expose the
token; connect the chosen transactional email provider before deployment.

Tenant creation is transactional. It provisions the default store, admin channel,
first-party merchant, owner membership, standard tenant roles, number sequences,
an audit record, and an outbox event before committing.

## Quality commands

```powershell
npm run lint
npm test
npm run warranties:verify
npm run taxes:verify
npm run taxes:invoice:verify
```

`warranties:verify` performs a read-only check of the tenant-scoped warranty
registry, claim queue, and summary data against the configured MariaDB database.

`taxes:verify` performs a read-only check of GST configuration, tax permissions,
and tenant-owner access against the configured MariaDB database.

`taxes:invoice:verify` creates, completes, and invoices a tax-ready order inside a
database transaction, validates totals and GST snapshots, and rolls everything
back so no verification order, invoice, or sequence increment is persisted.

For local demonstrations, `npm run seed:dummy-taxes` creates an explicitly marked
sample GST identity, example tax slabs, catalogue classifications, and the current
financial-year invoice series. The command refuses to run in production. These
fixtures are not legal or tax advice and must be replaced with verified business
registrations and classifications before deployment.

Run `npm run seed:dummy-tax-invoice-candidate` after the tax seed to create one
completed, tax-snapshotted demonstration order that is visible in the **Issue
invoice** workflow. Re-running the command does not duplicate that order.

For local promotion demonstrations, `npm run seed:dummy-promotions` creates three
idempotent sample offers with percentage, fixed-amount, and free-shipping rules,
plus coupon codes. The command refuses to run in production.

`npm run promotions:order:verify` creates a coupon-discounted manual order inside
a database transaction, validates the redemption and coupon usage increment, then
rolls the transaction back and confirms the usage counter was restored.

`npm run seller-pricing:verify` checks the seller-offer directory against MariaDB,
then exercises offer and INR price-list writes inside a transaction that is rolled back.

Database access uses the MariaDB-compatible `mysql2/promise` driver and DAOs. Controllers must not call DAOs directly; services own transactions and business rules. Asynchronous jobs and the transactional outbox are persisted in MariaDB and claimed by workers with database row locks.
