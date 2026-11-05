CREATE TABLE shopping_reminder_preferences (
 id BINARY(16) NOT NULL PRIMARY KEY,tenant_id BINARY(16) NOT NULL,store_id BINARY(16) NOT NULL,customer_id BINARY(16) NOT NULL,
 kind VARCHAR(12) NOT NULL,enabled TINYINT(1) NOT NULL DEFAULT 0,cycle_id BINARY(16) NOT NULL,version INT UNSIGNED NOT NULL DEFAULT 1,
 consented_at DATETIME(6) NULL,expires_at DATETIME(6) NULL,checked_at DATETIME(6) NULL,
 last_source_revision BIGINT UNSIGNED NULL,last_sent_at DATETIME(6) NULL,last_event_id BINARY(16) NULL,
 updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 UNIQUE KEY uq_reminder_owner(tenant_id,store_id,customer_id,kind),KEY ix_reminder_scan(enabled,expires_at,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),FOREIGN KEY(store_id) REFERENCES stores(id),FOREIGN KEY(customer_id) REFERENCES customers(id),
 CHECK(kind IN ('CART','WISHLIST')),CHECK(enabled IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE shopping_reminder_events (
 id BINARY(16) NOT NULL PRIMARY KEY,tenant_id BINARY(16) NOT NULL,preference_id BINARY(16) NOT NULL,cycle_id BINARY(16) NOT NULL,
 source_revision BIGINT UNSIGNED NOT NULL,source_owner_hash BINARY(32) NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 UNIQUE KEY uq_reminder_revision(preference_id,cycle_id,source_revision),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),FOREIGN KEY(preference_id) REFERENCES shopping_reminder_preferences(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
