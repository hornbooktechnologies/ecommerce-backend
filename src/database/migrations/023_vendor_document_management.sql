ALTER TABLE vendor_documents
  ADD COLUMN original_file_name VARCHAR(255) NULL AFTER file_key,
  ADD COLUMN mime_type VARCHAR(100) NULL AFTER original_file_name,
  ADD COLUMN file_size BIGINT UNSIGNED NULL AFTER mime_type,
  ADD COLUMN updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6) AFTER created_at;

CREATE INDEX ix_vendor_documents_review
  ON vendor_documents (tenant_id, verification_status, created_at);
