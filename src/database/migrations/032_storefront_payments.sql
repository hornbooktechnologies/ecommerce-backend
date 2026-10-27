-- Test-only gateway accounts are versioned so pending attempts survive key rotation.
CREATE TABLE tenant_payment_accounts (
  id BINARY(16) NOT NULL PRIMARY KEY,
  tenant_id BINARY(16) NOT NULL,
  key_id VARCHAR(80) NOT NULL,
  secret_encrypted TEXT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY ix_payment_account_tenant (tenant_id),
  CONSTRAINT fk_payment_account_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tenant_payment_settings (
  tenant_id BINARY(16) NOT NULL PRIMARY KEY,
  account_id BINARY(16) NOT NULL,
  CONSTRAINT fk_payment_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_payment_settings_account FOREIGN KEY (account_id) REFERENCES tenant_payment_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE store_payment_settings (
  tenant_id BINARY(16) NOT NULL,
  store_id BINARY(16) NOT NULL,
  cod_enabled TINYINT(1) NOT NULL DEFAULT 1,
  online_enabled TINYINT(1) NOT NULL DEFAULT 0,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, store_id),
  CONSTRAINT fk_store_payment_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_store_payment_store FOREIGN KEY (store_id) REFERENCES stores(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE customer_orders ADD COLUMN payment_method VARCHAR(30) NULL AFTER payment_status;

CREATE TABLE storefront_payment_attempts (
  id BINARY(16) NOT NULL PRIMARY KEY,
  tenant_id BINARY(16) NOT NULL,
  store_id BINARY(16) NOT NULL,
  customer_id BINARY(16) NOT NULL,
  order_id BINARY(16) NOT NULL,
  account_id BINARY(16) NOT NULL,
  payment_id BINARY(16) NOT NULL,
  amount_minor BIGINT UNSIGNED NOT NULL,
  gateway_order_id VARCHAR(80) NULL,
  captured_payment_id VARCHAR(80) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_storefront_payment_order (tenant_id, order_id),
  UNIQUE KEY uq_storefront_gateway_order (account_id, gateway_order_id),
  UNIQUE KEY uq_storefront_gateway_capture (account_id, captured_payment_id),
  CONSTRAINT fk_sf_payment_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_sf_payment_store FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT fk_sf_payment_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_sf_payment_order FOREIGN KEY (order_id) REFERENCES customer_orders(id),
  CONSTRAINT fk_sf_payment_account FOREIGN KEY (account_id) REFERENCES tenant_payment_accounts(id),
  CONSTRAINT fk_sf_payment_ledger FOREIGN KEY (payment_id) REFERENCES payments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
