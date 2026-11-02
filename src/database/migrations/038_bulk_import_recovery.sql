-- Atomic row application, fenced execution and inventory-file deduplication.
-- Existing COMMITTING jobs intentionally retain recovery_version = 0:
-- their business changes may have committed without a row result.
SET NAMES utf8mb4;
SET time_zone = '+00:00';

ALTER TABLE bulk_import_jobs
    ADD COLUMN recovery_version TINYINT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN run_token BINARY(16) NULL,
    ADD COLUMN lease_expires_at DATETIME(6) NULL,
    ADD COLUMN last_progress_at DATETIME(6) NULL,
    ADD COLUMN inventory_fingerprint BINARY(32) NULL,
    ADD UNIQUE KEY uq_bulk_inventory_file (tenant_id, inventory_fingerprint);
