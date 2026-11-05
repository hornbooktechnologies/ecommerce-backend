CREATE TABLE customer_history_preferences (
 tenant_id BINARY(16) NOT NULL,store_id BINARY(16) NOT NULL,customer_id BINARY(16) NOT NULL,
 enabled TINYINT(1) NOT NULL DEFAULT 1,version INT UNSIGNED NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,store_id,customer_id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),FOREIGN KEY(store_id) REFERENCES stores(id),FOREIGN KEY(customer_id) REFERENCES customers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE customer_recent_products (
 tenant_id BINARY(16) NOT NULL,store_id BINARY(16) NOT NULL,customer_id BINARY(16) NOT NULL,product_id BINARY(16) NOT NULL,
 viewed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(tenant_id,store_id,customer_id,product_id),KEY ix_recent_expiry(viewed_at),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),FOREIGN KEY(store_id) REFERENCES stores(id),
 FOREIGN KEY(customer_id) REFERENCES customers(id),FOREIGN KEY(product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE shopping_alert_subscriptions (
 id BINARY(16) NOT NULL,tenant_id BINARY(16) NOT NULL,store_id BINARY(16) NOT NULL,customer_id BINARY(16) NOT NULL,offer_id BINARY(16) NOT NULL,
 kind VARCHAR(20) NOT NULL,status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',cycle_id BINARY(16) NOT NULL,
 baseline_price DECIMAL(19,4) NOT NULL,currency CHAR(3) NOT NULL,
 consent_version VARCHAR(30) NOT NULL DEFAULT 'IN_APP_SHOPPING_V1',consented_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 expires_at DATETIME(6) NOT NULL,checked_at DATETIME(6) NULL,triggered_at DATETIME(6) NULL,cancelled_at DATETIME(6) NULL,
 version INT UNSIGNED NOT NULL DEFAULT 1,created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),UNIQUE KEY uq_shopping_subscription(tenant_id,store_id,customer_id,offer_id,kind),
 KEY ix_shopping_scan(status,id),KEY ix_shopping_owner(tenant_id,store_id,customer_id,status),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),FOREIGN KEY(store_id) REFERENCES stores(id),FOREIGN KEY(customer_id) REFERENCES customers(id),FOREIGN KEY(offer_id) REFERENCES seller_offers(id),
 CHECK(kind IN ('BACK_IN_STOCK','PRICE_DROP')),CHECK(status IN ('ACTIVE','TRIGGERED','CANCELLED','EXPIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE shopping_alert_events (
 id BINARY(16) NOT NULL,tenant_id BINARY(16) NOT NULL,subscription_id BINARY(16) NOT NULL,cycle_id BINARY(16) NOT NULL,
 observed_price DECIMAL(19,4) NOT NULL,created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 PRIMARY KEY(id),UNIQUE KEY uq_shopping_cycle(subscription_id,cycle_id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id),FOREIGN KEY(subscription_id) REFERENCES shopping_alert_subscriptions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
