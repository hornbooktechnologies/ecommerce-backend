CREATE TABLE payment_webhook_secrets (
  id BINARY(16) NOT NULL PRIMARY KEY,
  account_id BINARY(16) NOT NULL,
  secret_encrypted TEXT NOT NULL,
  expires_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY ix_webhook_secrets_account (account_id, expires_at),
  CONSTRAINT fk_webhook_secret_account FOREIGN KEY (account_id) REFERENCES tenant_payment_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_webhook_events (
  id BINARY(16) NOT NULL PRIMARY KEY,
  tenant_id BINARY(16) NOT NULL,
  account_id BINARY(16) NOT NULL,
  event_id VARCHAR(190) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  gateway_order_id VARCHAR(80) NOT NULL,
  gateway_payment_id VARCHAR(80) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_error VARCHAR(80) NULL,
  processed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_payment_webhook_event (account_id, event_id),
  KEY ix_payment_webhook_due (status, next_attempt_at),
  CONSTRAINT fk_webhook_event_account FOREIGN KEY (account_id) REFERENCES tenant_payment_accounts(id),
  CONSTRAINT fk_webhook_event_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE storefront_payment_attempts
  ADD COLUMN next_reconcile_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  ADD COLUMN last_reconciled_at DATETIME(6) NULL,
  ADD COLUMN reconcile_failures INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN last_reconcile_error VARCHAR(80) NULL,
  ADD KEY ix_payment_recovery_due (captured_payment_id, next_reconcile_at);
