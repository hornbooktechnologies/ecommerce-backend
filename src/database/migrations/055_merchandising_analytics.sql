CREATE TABLE merchandising_sessions (
 id BINARY(16) NOT NULL,tenant_id BINARY(16) NOT NULL,store_id BINARY(16) NOT NULL,
 token_hash BINARY(32) NULL,enabled TINYINT(1) NOT NULL DEFAULT 1,
 consented_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),expires_at DATETIME(6) NOT NULL,
 PRIMARY KEY(id),UNIQUE KEY uq_merch_token(tenant_id,store_id,token_hash),KEY ix_merch_expiry(expires_at),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),FOREIGN KEY(store_id) REFERENCES stores(id),CHECK(enabled IN(0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE merchandising_sources (
 id BINARY(16) NOT NULL,tenant_id BINARY(16) NOT NULL,store_id BINARY(16) NOT NULL,collection_id BINARY(16) NOT NULL,
 source_hash BINARY(32) NOT NULL,kind VARCHAR(20) NOT NULL,source_key VARCHAR(160) NOT NULL,
 collection_title VARCHAR(120) NOT NULL,source_label VARCHAR(120) NOT NULL,
 PRIMARY KEY(id),UNIQUE KEY uq_merch_source(tenant_id,store_id,source_hash),KEY ix_merch_collection(tenant_id,store_id,collection_id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),FOREIGN KEY(store_id) REFERENCES stores(id),FOREIGN KEY(collection_id) REFERENCES store_collections(id),
 CHECK(kind IN('COLLECTION','HERO','BANNER','SHELF'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE merchandising_events (
 id BINARY(16) NOT NULL,tenant_id BINARY(16) NOT NULL,store_id BINARY(16) NOT NULL,
 session_id BINARY(16) NOT NULL,source_id BINARY(16) NOT NULL,kind VARCHAR(10) NOT NULL,
 product_id BINARY(16) NULL,dedupe_hash BINARY(32) NOT NULL,
 created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),UNIQUE KEY uq_merch_event(session_id,dedupe_hash),KEY ix_merch_report(tenant_id,store_id,created_at,source_id),
 KEY ix_merch_click(tenant_id,store_id,session_id,kind,product_id,last_seen_at),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),FOREIGN KEY(store_id) REFERENCES stores(id),
 FOREIGN KEY(session_id) REFERENCES merchandising_sessions(id),FOREIGN KEY(source_id) REFERENCES merchandising_sources(id),FOREIGN KEY(product_id) REFERENCES products(id),
 CHECK(kind IN('VIEW','OPEN','CLICK','ADD'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE merchandising_order_items (
 order_item_id BINARY(16) NOT NULL,tenant_id BINARY(16) NOT NULL,store_id BINARY(16) NOT NULL,
 source_id BINARY(16) NOT NULL,touch_id BINARY(16) NOT NULL,
 PRIMARY KEY(order_item_id),KEY ix_merch_order_source(tenant_id,store_id,source_id),
 FOREIGN KEY(order_item_id) REFERENCES order_items(id),FOREIGN KEY(tenant_id) REFERENCES tenants(id),FOREIGN KEY(store_id) REFERENCES stores(id),
 FOREIGN KEY(source_id) REFERENCES merchandising_sources(id),FOREIGN KEY(touch_id) REFERENCES merchandising_events(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
