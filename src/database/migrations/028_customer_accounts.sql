CREATE TABLE customer_accounts (
  tenant_id BINARY(16) NOT NULL,
  customer_id BINARY(16) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  verified_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (tenant_id, customer_id),
  UNIQUE KEY uq_customer_account_email (tenant_id, email),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_sessions (
  token_hash BINARY(32) NOT NULL,
  tenant_id BINARY(16) NOT NULL,
  customer_id BINARY(16) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (token_hash),
  KEY ix_customer_session_expiry (expires_at),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customer_accounts(tenant_id, customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_email_tokens (
  token_hash BINARY(32) NOT NULL,
  tenant_id BINARY(16) NOT NULL,
  store_id BINARY(16) NOT NULL,
  email VARCHAR(254) NOT NULL,
  purpose VARCHAR(20) NOT NULL,
  customer_id BINARY(16) NULL,
  first_name VARCHAR(100) NOT NULL DEFAULT '',
  last_name VARCHAR(100) NOT NULL DEFAULT '',
  expires_at DATETIME(6) NOT NULL,
  PRIMARY KEY (token_hash),
  KEY ix_customer_email_tokens (tenant_id, email, purpose),
  KEY ix_customer_email_expiry (expires_at),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (store_id) REFERENCES stores(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_auth_limits (
  bucket_hash BINARY(32) NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 1,
  expires_at DATETIME(6) NOT NULL,
  PRIMARY KEY (bucket_hash),
  KEY ix_customer_auth_limit_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
