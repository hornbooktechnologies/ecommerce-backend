CREATE TABLE specification_definitions (
 id BINARY(16) NOT NULL, tenant_id BINARY(16) NOT NULL,
 code VARCHAR(60) NOT NULL, name VARCHAR(120) NOT NULL,
 vertical VARCHAR(20) NOT NULL, category_id BINARY(16) NULL,
 data_type VARCHAR(10) NOT NULL, unit VARCHAR(30) NOT NULL DEFAULT '',
 group_name VARCHAR(80) NOT NULL DEFAULT 'Details', help_text VARCHAR(500) NOT NULL DEFAULT '',
 options_json JSON NOT NULL, customer_visible TINYINT(1) NOT NULL DEFAULT 0,
 sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0, status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
 version INT UNSIGNED NOT NULL DEFAULT 1,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id), UNIQUE KEY uq_specification_code(tenant_id,code),
 UNIQUE KEY uq_specification_scope(tenant_id,id),
 KEY ix_specification_directory(tenant_id,vertical,status,sort_order),
 CONSTRAINT fk_specification_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 CONSTRAINT fk_specification_category FOREIGN KEY(category_id) REFERENCES categories(id),
 CONSTRAINT ck_specification_type CHECK(data_type IN ('TEXT','NUMBER','BOOLEAN','DATE','SELECT')),
 CONSTRAINT ck_specification_vertical CHECK(vertical IN ('GENERAL','GROCERY','ELECTRONICS','CLOTHING')),
 CONSTRAINT ck_specification_status CHECK(status IN ('ACTIVE','INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_specification_sets (
 tenant_id BINARY(16) NOT NULL, product_id BINARY(16) NOT NULL,
 version INT UNSIGNED NOT NULL DEFAULT 1,
 updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 PRIMARY KEY(product_id), UNIQUE KEY uq_product_specification_set(tenant_id,product_id),
 CONSTRAINT fk_specification_set_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 CONSTRAINT fk_specification_set_product FOREIGN KEY(product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_specification_values (
 tenant_id BINARY(16) NOT NULL, product_id BINARY(16) NOT NULL, definition_id BINARY(16) NOT NULL,
 value_json JSON NOT NULL,
 PRIMARY KEY(product_id,definition_id), KEY ix_specification_values(tenant_id,definition_id),
 CONSTRAINT fk_specification_value_set FOREIGN KEY(tenant_id,product_id) REFERENCES product_specification_sets(tenant_id,product_id),
 CONSTRAINT fk_specification_value_definition FOREIGN KEY(tenant_id,definition_id) REFERENCES specification_definitions(tenant_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
