-- MariaDB 10.4. Guest tokens are stored only as hashes; account lists never expire.
CREATE TABLE storefront_wishlists (
  tenant_id BINARY(16) NOT NULL,
  store_id BINARY(16) NOT NULL,
  owner_hash BINARY(32) NOT NULL,
  customer_id BINARY(16) NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  product_ids_json JSON NOT NULL,
  legacy_imported TINYINT(1) NOT NULL DEFAULT 0,
  consumed_at DATETIME(6) NULL,
  expires_at DATETIME(6) NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, store_id, owner_hash),
  KEY ix_storefront_wishlist_expiry (expires_at),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customer_accounts(tenant_id, customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
