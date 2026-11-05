-- Display preferences only. Financial prices, orders and payments remain INR.
CREATE TABLE store_localization (
  tenant_id BINARY(16) NOT NULL,
  store_id BINARY(16) NOT NULL,
  default_language VARCHAR(5) NOT NULL DEFAULT 'en',
  languages_json JSON NOT NULL,
  currencies_json JSON NOT NULL,
  rates_json JSON NOT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  updated_by BINARY(16) NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, store_id),
  UNIQUE KEY uq_store_localization_store (store_id),
  CONSTRAINT fk_store_localization_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_store_localization_store FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT fk_store_localization_actor FOREIGN KEY (updated_by) REFERENCES users(id),
  CONSTRAINT ck_store_localization_language CHECK (default_language IN ('en','hi','gu'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
