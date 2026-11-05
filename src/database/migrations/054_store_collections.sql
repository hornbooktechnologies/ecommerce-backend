CREATE TABLE store_collections (
 id BINARY(16) NOT NULL, tenant_id BINARY(16) NOT NULL, store_id BINARY(16) NOT NULL,
 slug VARCHAR(120) NOT NULL, draft_json JSON NOT NULL, published_json JSON NULL,
 is_visible TINYINT(1) NOT NULL DEFAULT 0, revision INT UNSIGNED NOT NULL DEFAULT 1,
 published_at DATETIME(6) NULL, updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id), UNIQUE KEY uq_store_collection_slug(tenant_id,store_id,slug),
 KEY ix_store_collections(tenant_id,store_id,is_visible,updated_at),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id), FOREIGN KEY(store_id) REFERENCES stores(id),
 CHECK(is_visible IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
