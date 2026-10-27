CREATE TABLE storefront_checkouts (
  id BINARY(16) NOT NULL,
  tenant_id BINARY(16) NOT NULL,
  store_id BINARY(16) NOT NULL,
  customer_id BINARY(16) NOT NULL,
  cart_revision INT UNSIGNED NOT NULL,
  quote_json JSON NOT NULL,
  order_id BINARY(16) NULL,
  receipt_json JSON NULL,
  expires_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(id),
  KEY ix_checkout_customer (tenant_id, store_id, customer_id, created_at),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customer_accounts(tenant_id, customer_id),
  FOREIGN KEY (store_id) REFERENCES stores(id),
  FOREIGN KEY (order_id) REFERENCES customer_orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
