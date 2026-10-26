-- Migration 024: tenant-scoped product ratings and review moderation.
-- Compatible with MariaDB 10.4.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE product_ratings (
    id BINARY(16) NOT NULL,
    tenant_id BINARY(16) NOT NULL,
    product_id BINARY(16) NOT NULL,
    customer_id BINARY(16) NULL,
    customer_order_id BINARY(16) NULL,
    order_item_id BINARY(16) NULL,
    rating TINYINT UNSIGNED NOT NULL,
    title VARCHAR(190) NULL,
    review_text TEXT NULL,
    customer_name_snapshot VARCHAR(190) NULL,
    customer_email_snapshot VARCHAR(254) NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    source VARCHAR(30) NOT NULL DEFAULT 'STOREFRONT',
    verified_purchase TINYINT(1) NOT NULL DEFAULT 0,
    helpful_count INT UNSIGNED NOT NULL DEFAULT 0,
    moderation_notes VARCHAR(1000) NULL,
    moderated_by BINARY(16) NULL,
    moderated_at DATETIME(6) NULL,
    submitted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    deleted_at DATETIME(6) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_product_ratings_order_item (tenant_id, order_item_id),
    KEY ix_product_ratings_queue (tenant_id, status, submitted_at),
    KEY ix_product_ratings_product (tenant_id, product_id, status, rating),
    KEY ix_product_ratings_customer (tenant_id, customer_id, submitted_at),
    CONSTRAINT fk_product_ratings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id),
    CONSTRAINT fk_product_ratings_product FOREIGN KEY (product_id) REFERENCES products (id),
    CONSTRAINT fk_product_ratings_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
    CONSTRAINT fk_product_ratings_order FOREIGN KEY (customer_order_id) REFERENCES customer_orders (id),
    CONSTRAINT fk_product_ratings_order_item FOREIGN KEY (order_item_id) REFERENCES order_items (id),
    CONSTRAINT fk_product_ratings_moderator FOREIGN KEY (moderated_by) REFERENCES users (id),
    CONSTRAINT ck_product_ratings_score CHECK (rating BETWEEN 1 AND 5),
    CONSTRAINT ck_product_ratings_status CHECK (status IN ('PENDING', 'PUBLISHED', 'HIDDEN', 'FLAGGED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (id, permission_key, module_name, description) VALUES
  (UNHEX(MD5('rating.read')), 'rating.read', 'Product ratings', 'View product ratings and moderation status'),
  (UNHEX(MD5('rating.moderate')), 'rating.moderate', 'Product ratings', 'Publish, hide, and flag product ratings');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.permission_key IN ('rating.read', 'rating.moderate')
 WHERE r.role_level = 'TENANT'
   AND r.role_key IN ('tenant_owner', 'tenant_administrator', 'catalog_manager')
   AND r.deleted_at IS NULL;

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.permission_key = 'rating.read'
 WHERE r.role_level = 'TENANT'
   AND r.role_key IN ('vendor_manager', 'analyst', 'auditor')
   AND r.deleted_at IS NULL;
