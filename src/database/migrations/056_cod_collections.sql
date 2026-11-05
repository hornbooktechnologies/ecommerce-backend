-- Full-value, delivered-order COD receipts. MariaDB 10.4 compatible.
SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE cod_collections (
  id BINARY(16) NOT NULL PRIMARY KEY,
  tenant_id BINARY(16) NOT NULL,
  order_id BINARY(16) NOT NULL,
  payment_id BINARY(16) NOT NULL,
  request_key BINARY(16) NOT NULL,
  request_hash BINARY(32) NOT NULL,
  amount DECIMAL(19,4) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  collection_reference VARCHAR(120) NOT NULL,
  collected_at DATETIME(6) NOT NULL,
  recorded_by BINARY(16) NOT NULL,
  notes VARCHAR(1000) NOT NULL DEFAULT '',
  recorded_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_cod_order (tenant_id, order_id),
  UNIQUE KEY uq_cod_request (tenant_id, request_key),
  KEY ix_cod_collected (tenant_id, collected_at),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (order_id) REFERENCES customer_orders(id),
  FOREIGN KEY (payment_id) REFERENCES payments(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id),
  CONSTRAINT ck_cod_amount CHECK (amount > 0),
  CONSTRAINT ck_cod_currency CHECK (currency = 'INR')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions(id, permission_key, module_name, description)
VALUES (UNHEX(MD5('order.payment.collect')), 'order.payment.collect', 'Orders', 'Record full COD collection on delivered orders');

INSERT IGNORE INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key = 'order.payment.collect'
WHERE r.role_level = 'TENANT' AND r.is_system = 1 AND r.role_key IN ('tenant_owner','tenant_administrator','finance_manager')
  AND r.deleted_at IS NULL;

INSERT IGNORE INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key = 'order.read'
WHERE r.role_level = 'TENANT' AND r.is_system = 1 AND r.role_key = 'finance_manager' AND r.deleted_at IS NULL;
