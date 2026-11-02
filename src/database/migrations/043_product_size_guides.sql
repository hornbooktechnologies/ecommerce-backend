CREATE TABLE size_guides (
 id BINARY(16) NOT NULL,
 tenant_id BINARY(16) NOT NULL,
 name VARCHAR(190) NOT NULL,
 unit VARCHAR(10) NOT NULL,
 measurement_basis VARCHAR(20) NOT NULL,
 description VARCHAR(1000) NOT NULL DEFAULT '',
 instructions TEXT NOT NULL,
 columns_json JSON NOT NULL,
 rows_json JSON NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
 version INT UNSIGNED NOT NULL DEFAULT 1,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 deleted_at DATETIME(6) NULL,
 PRIMARY KEY (id), UNIQUE KEY uq_size_guide_tenant (tenant_id,id),
 KEY ix_size_guides_directory (tenant_id,status,deleted_at,name),
 CONSTRAINT fk_size_guide_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
 CONSTRAINT ck_size_guide_unit CHECK (unit IN ('CM','IN')),
 CONSTRAINT ck_size_guide_basis CHECK (measurement_basis IN ('BODY','GARMENT')),
 CONSTRAINT ck_size_guide_status CHECK (status IN ('ACTIVE','INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_size_guides (
 tenant_id BINARY(16) NOT NULL,
 product_id BINARY(16) NOT NULL,
 guide_id BINARY(16) NOT NULL,
 updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 PRIMARY KEY (product_id), KEY ix_product_size_guides_guide (tenant_id,guide_id),
 CONSTRAINT fk_product_size_guide_product FOREIGN KEY (product_id) REFERENCES products(id),
 CONSTRAINT fk_product_size_guide_guide FOREIGN KEY (tenant_id,guide_id) REFERENCES size_guides(tenant_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
