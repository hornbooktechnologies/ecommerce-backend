CREATE TABLE product_questions (
 id BINARY(16) NOT NULL, tenant_id BINARY(16) NOT NULL, store_id BINARY(16) NOT NULL,
 product_id BINARY(16) NOT NULL, customer_id BINARY(16) NOT NULL,
 question_text VARCHAR(1000) NOT NULL, body_hash BINARY(32) NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'PENDING', version INT UNSIGNED NOT NULL DEFAULT 1,
 moderation_note VARCHAR(1000) NOT NULL DEFAULT '', moderated_by BINARY(16) NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id), UNIQUE KEY uq_question_scope(tenant_id,id),
 UNIQUE KEY uq_question_retry(tenant_id,store_id,product_id,customer_id,body_hash),
 KEY ix_question_queue(tenant_id,status,created_at,id),
 KEY ix_question_public(tenant_id,store_id,product_id,status,created_at),
 KEY ix_question_customer(tenant_id,store_id,customer_id,created_at),
 CONSTRAINT fk_question_tenant FOREIGN KEY(tenant_id) REFERENCES tenants(id),
 CONSTRAINT fk_question_store FOREIGN KEY(store_id) REFERENCES stores(id),
 CONSTRAINT fk_question_product FOREIGN KEY(product_id) REFERENCES products(id),
 CONSTRAINT fk_question_customer FOREIGN KEY(customer_id) REFERENCES customers(id),
 CONSTRAINT fk_question_moderator FOREIGN KEY(moderated_by) REFERENCES users(id),
 CONSTRAINT ck_question_status CHECK(status IN ('PENDING','APPROVED','REJECTED','HIDDEN','WITHDRAWN'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_question_answers (
 id BINARY(16) NOT NULL, tenant_id BINARY(16) NOT NULL, question_id BINARY(16) NOT NULL,
 merchant_id BINARY(16) NULL, created_by BINARY(16) NOT NULL,
 answer_text VARCHAR(3000) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
 moderation_note VARCHAR(1000) NOT NULL DEFAULT '', moderated_by BINARY(16) NULL,
 published_slot TINYINT AS (IF(status='PUBLISHED',1,NULL)) PERSISTENT,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id), UNIQUE KEY uq_question_published(question_id,published_slot),
 KEY ix_question_answer_queue(tenant_id,question_id,status,created_at),
 CONSTRAINT fk_answer_question FOREIGN KEY(tenant_id,question_id) REFERENCES product_questions(tenant_id,id),
 CONSTRAINT fk_answer_merchant FOREIGN KEY(merchant_id) REFERENCES merchants(id),
 CONSTRAINT fk_answer_author FOREIGN KEY(created_by) REFERENCES users(id),
 CONSTRAINT fk_answer_moderator FOREIGN KEY(moderated_by) REFERENCES users(id),
 CONSTRAINT ck_question_answer_status CHECK(status IN ('PENDING','PUBLISHED','REJECTED','REPLACED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions(id,permission_key,module_name,description) VALUES
 (UNHEX(MD5('question.read')),'question.read','Product questions','View tenant product questions and answer history'),
 (UNHEX(MD5('question.answer')),'question.answer','Product questions','Submit store answers for moderation'),
 (UNHEX(MD5('question.moderate')),'question.moderate','Product questions','Approve, reject and hide product Q&A'),
 (UNHEX(MD5('vendor.question.read')),'vendor.question.read','Vendor questions','View approved questions for actively sold products'),
 (UNHEX(MD5('vendor.question.answer')),'vendor.question.answer','Vendor questions','Submit vendor answers for moderation');
INSERT IGNORE INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r JOIN permissions p ON p.permission_key IN ('question.read','question.answer','question.moderate')
 WHERE r.role_level='TENANT' AND r.role_key IN ('tenant_owner','tenant_administrator','catalog_manager') AND r.deleted_at IS NULL;
INSERT IGNORE INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r JOIN permissions p ON p.permission_key='question.read'
 WHERE r.role_level='TENANT' AND r.role_key IN ('analyst','auditor') AND r.deleted_at IS NULL;
INSERT IGNORE INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r JOIN permissions p ON p.permission_key IN ('vendor.question.read','vendor.question.answer')
 WHERE r.role_level='VENDOR' AND r.role_key IN ('vendor_owner','vendor_catalog_manager') AND r.deleted_at IS NULL;
