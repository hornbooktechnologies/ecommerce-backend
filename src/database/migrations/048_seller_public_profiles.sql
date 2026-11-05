CREATE TABLE seller_public_profiles (
 tenant_id BINARY(16) NOT NULL,store_id BINARY(16) NOT NULL,merchant_id BINARY(16) NOT NULL,
 draft_content JSON NOT NULL,published_content JSON NULL,is_visible TINYINT(1) NOT NULL DEFAULT 0,
 version INT UNSIGNED NOT NULL DEFAULT 1,published_at DATETIME(6) NULL,
 updated_by BINARY(16) NOT NULL,updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 PRIMARY KEY(tenant_id,store_id,merchant_id),KEY ix_seller_profile_visibility(tenant_id,store_id,is_visible),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),FOREIGN KEY(store_id) REFERENCES stores(id),
 FOREIGN KEY(merchant_id) REFERENCES merchants(id),FOREIGN KEY(updated_by) REFERENCES users(id),
 CHECK(is_visible IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
