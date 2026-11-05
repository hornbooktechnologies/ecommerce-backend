CREATE TABLE size_guide_defaults (
 id BINARY(16) NOT NULL PRIMARY KEY,tenant_id BINARY(16) NOT NULL,
 brand_id BINARY(16) NULL,category_id BINARY(16) NULL,scope_key VARCHAR(73) NOT NULL,
 guide_id BINARY(16) NOT NULL,status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
 version INT UNSIGNED NOT NULL DEFAULT 1,updated_by BINARY(16) NOT NULL,
 updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 UNIQUE KEY uq_size_guide_default_scope(tenant_id,scope_key),
 KEY ix_size_guide_default_match(tenant_id,status,brand_id,category_id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),FOREIGN KEY(brand_id) REFERENCES brands(id),
 FOREIGN KEY(category_id) REFERENCES categories(id),FOREIGN KEY(tenant_id,guide_id) REFERENCES size_guides(tenant_id,id),
 FOREIGN KEY(updated_by) REFERENCES users(id),
 CHECK(brand_id IS NOT NULL OR category_id IS NOT NULL),CHECK(status IN ('ACTIVE','INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE product_size_guide_exclusions (
 product_id BINARY(16) NOT NULL PRIMARY KEY,tenant_id BINARY(16) NOT NULL,
 FOREIGN KEY(product_id) REFERENCES products(id),FOREIGN KEY(tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
