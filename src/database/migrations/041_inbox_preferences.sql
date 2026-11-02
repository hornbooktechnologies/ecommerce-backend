-- Opt-outs affect new recipient snapshots only; historical rows remain visible.
SET NAMES utf8mb4;
SET time_zone = '+00:00';
CREATE TABLE inbox_preferences (
    tenant_id BINARY(16) NOT NULL,
    audience VARCHAR(20) NOT NULL,
    recipient_id BINARY(16) NOT NULL,
    store_scope BINARY(16) NOT NULL,
    disabled_categories JSON NOT NULL,
    revision INT UNSIGNED NOT NULL DEFAULT 1,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (tenant_id, audience, recipient_id, store_scope),
    CONSTRAINT fk_inbox_preferences_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT ck_inbox_preferences_audience CHECK (audience IN ('ADMIN','CUSTOMER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE inbox_recipients
    ADD COLUMN suppressed_at DATETIME(6) NULL,
    ADD KEY ix_inbox_visible_owner (tenant_id, recipient_id, suppressed_at, created_at, id);
