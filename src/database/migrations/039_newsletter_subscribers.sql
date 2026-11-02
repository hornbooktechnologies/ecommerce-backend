-- Tenant/store-scoped, email-confirmed newsletter consent. MariaDB 10.4.
SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE newsletter_subscribers (
    id BINARY(16) NOT NULL,
    tenant_id BINARY(16) NOT NULL,
    store_id BINARY(16) NOT NULL,
    email VARCHAR(254) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    consent_version VARCHAR(40) NOT NULL,
    consent_requested_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    confirmed_at DATETIME(6) NULL,
    unsubscribed_at DATETIME(6) NULL,
    confirm_token_hash BINARY(32) NULL,
    confirm_expires_at DATETIME(6) NULL,
    unsubscribe_token_hash BINARY(32) NULL,
    confirmation_delivery VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    revision INT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_newsletter_store_email (tenant_id, store_id, email),
    KEY ix_newsletter_status_created (tenant_id, store_id, status, created_at),
    KEY ix_newsletter_confirm (tenant_id, store_id, confirm_token_hash),
    KEY ix_newsletter_unsubscribe (tenant_id, store_id, unsubscribe_token_hash),
    CONSTRAINT fk_newsletter_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_newsletter_store FOREIGN KEY (store_id) REFERENCES stores(id),
    CONSTRAINT ck_newsletter_status CHECK (status IN ('PENDING', 'ACTIVE', 'UNSUBSCRIBED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (id, permission_key, module_name, description) VALUES
  (UNHEX(MD5('newsletter.read')), 'newsletter.read', 'Newsletter', 'View store newsletter subscribers and consent status'),
  (UNHEX(MD5('newsletter.manage')), 'newsletter.manage', 'Newsletter', 'Unsubscribe newsletter recipients; cannot opt people in');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
 WHERE r.role_level = 'TENANT' AND r.role_key IN ('tenant_owner', 'tenant_administrator')
   AND r.deleted_at IS NULL AND p.permission_key IN ('newsletter.read', 'newsletter.manage');
