-- Persistent in-app inbox, independent from SMTP delivery. No historical backfill.
CREATE TABLE inbox_events (
  id BINARY(16) NOT NULL PRIMARY KEY,
  tenant_id BINARY(16) NOT NULL,
  event_key VARCHAR(190) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  audience VARCHAR(20) NOT NULL,
  store_id BINARY(16) NULL,
  merchant_id BINARY(16) NULL,
  kind VARCHAR(60) NOT NULL,
  category VARCHAR(30) NOT NULL,
  entity_type VARCHAR(30) NOT NULL,
  entity_id BINARY(16) NOT NULL,
  order_id BINARY(16) NULL,
  required_permission VARCHAR(120) NULL,
  title VARCHAR(190) NOT NULL,
  message VARCHAR(1000) NOT NULL,
  recipients JSON NOT NULL,
  recipient_offset INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
  attempt_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_error VARCHAR(80) NULL,
  processed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_inbox_event (tenant_id, event_key),
  KEY ix_inbox_event_due (status, next_attempt_at, id),
  CONSTRAINT fk_inbox_event_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT ck_inbox_event_audience CHECK (audience IN ('ADMIN','VENDOR','CUSTOMER','PLATFORM'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inbox_recipients (
  id BINARY(16) NOT NULL PRIMARY KEY,
  tenant_id BINARY(16) NOT NULL,
  event_id BINARY(16) NOT NULL,
  recipient_id BINARY(16) NOT NULL,
  read_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_inbox_recipient (event_id, recipient_id),
  KEY ix_inbox_owner (tenant_id, recipient_id, created_at, id),
  KEY ix_inbox_unread (tenant_id, recipient_id, read_at),
  CONSTRAINT fk_inbox_recipient_event FOREIGN KEY (event_id) REFERENCES inbox_events(id),
  CONSTRAINT fk_inbox_recipient_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
