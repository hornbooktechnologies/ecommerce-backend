-- Store-specific draft/published hero content. MariaDB 10.4 compatible.
CREATE TABLE store_homepage_heroes (
  tenant_id BINARY(16) NOT NULL,
  store_id BINARY(16) NOT NULL,
  draft_json JSON NOT NULL,
  published_json JSON NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  published_at DATETIME(6) NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, store_id),
  CONSTRAINT fk_hero_store FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT fk_hero_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE store_homepage_assets (
  id BINARY(16) NOT NULL,
  tenant_id BINARY(16) NOT NULL,
  store_id BINARY(16) NOT NULL,
  url VARCHAR(2048) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_hero_asset_scope (tenant_id, store_id),
  CONSTRAINT fk_hero_asset_store FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT fk_hero_asset_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
