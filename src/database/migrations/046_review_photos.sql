ALTER TABLE product_ratings ADD UNIQUE KEY uq_rating_tenant_id(tenant_id,id);
CREATE TABLE review_photos (
 id BINARY(16) NOT NULL, tenant_id BINARY(16) NOT NULL, review_id BINARY(16) NOT NULL,
 storage_key CHAR(37) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 source_hash BINARY(32) NOT NULL, alt_text VARCHAR(190) NOT NULL,
 storage_state VARCHAR(10) NOT NULL DEFAULT 'STAGED', status VARCHAR(10) NOT NULL DEFAULT 'PENDING',
 width SMALLINT UNSIGNED NULL, height SMALLINT UNSIGNED NULL, byte_size INT UNSIGNED NULL,
 version INT UNSIGNED NOT NULL DEFAULT 1, moderation_note VARCHAR(1000) NOT NULL DEFAULT '',
 moderated_by BINARY(16) NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 deleted_at DATETIME(6) NULL, file_removed_at DATETIME(6) NULL,
 PRIMARY KEY(id), UNIQUE KEY uq_review_photo_key(storage_key),
 KEY ix_review_photos_review(tenant_id,review_id,deleted_at,status),
 KEY ix_review_photos_cleanup(deleted_at,file_removed_at),
 KEY ix_review_photos_attempts(tenant_id,created_at,review_id),
 CONSTRAINT fk_photo_review FOREIGN KEY(tenant_id,review_id) REFERENCES product_ratings(tenant_id,id),
 CONSTRAINT fk_photo_moderator FOREIGN KEY(moderated_by) REFERENCES users(id),
 CONSTRAINT ck_review_photo_status CHECK(status IN ('PENDING','APPROVED','HIDDEN','REJECTED','REMOVED')),
 CONSTRAINT ck_review_photo_state CHECK(storage_state IN ('STAGED','READY'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
