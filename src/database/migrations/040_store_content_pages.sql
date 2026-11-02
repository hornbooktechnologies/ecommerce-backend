-- Store-specific drafts and independently published information/policy pages.
SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE store_content_pages (
    id BINARY(16) NOT NULL,
    tenant_id BINARY(16) NOT NULL,
    store_id BINARY(16) NOT NULL,
    page_key VARCHAR(20) NOT NULL,
    draft_document JSON NOT NULL,
    published_document JSON NULL,
    revision INT UNSIGNED NOT NULL DEFAULT 1,
    published_revision INT UNSIGNED NULL,
    published_at DATETIME(6) NULL,
    published_by BINARY(16) NULL,
    updated_by BINARY(16) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_store_content_page (tenant_id, store_id, page_key),
    CONSTRAINT fk_content_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_content_store FOREIGN KEY (store_id) REFERENCES stores(id),
    CONSTRAINT fk_content_editor FOREIGN KEY (updated_by) REFERENCES users(id),
    CONSTRAINT fk_content_publisher FOREIGN KEY (published_by) REFERENCES users(id),
    CONSTRAINT ck_content_page_key CHECK (page_key IN ('ABOUT', 'CONTACT', 'SHIPPING', 'RETURNS', 'PRIVACY', 'TERMS'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (id, permission_key, module_name, description) VALUES
  (UNHEX(MD5('store.content.read')), 'store.content.read', 'Store pages', 'View and preview store information and policy drafts'),
  (UNHEX(MD5('store.content.manage')), 'store.content.manage', 'Store pages', 'Save store information and policy drafts'),
  (UNHEX(MD5('store.content.publish')), 'store.content.publish', 'Store pages', 'Publish and withdraw approved store pages');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
 WHERE r.role_level = 'TENANT' AND r.role_key IN ('tenant_owner', 'tenant_administrator')
   AND r.deleted_at IS NULL AND p.permission_key IN ('store.content.read', 'store.content.manage', 'store.content.publish');
