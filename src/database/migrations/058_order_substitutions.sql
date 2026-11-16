-- Operator-assisted grocery substitutions. MariaDB 10.4 compatible.
CREATE TABLE order_item_substitutions (
  id BINARY(16) NOT NULL PRIMARY KEY,
  tenant_id BINARY(16) NOT NULL,
  order_id BINARY(16) NOT NULL,
  order_item_id BINARY(16) NOT NULL,
  rule_id BINARY(16) NOT NULL,
  warehouse_id BINARY(16) NOT NULL,
  request_key BINARY(16) NOT NULL,
  request_hash BINARY(32) NOT NULL,
  original_snapshot JSON NOT NULL,
  replacement_snapshot JSON NOT NULL,
  consent_basis VARCHAR(30) NOT NULL,
  approval_reference VARCHAR(300) NULL,
  reason VARCHAR(500) NOT NULL,
  recorded_by BINARY(16) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_substitution_item (tenant_id, order_item_id),
  UNIQUE KEY uq_substitution_request (tenant_id, request_key),
  KEY ix_substitution_order (tenant_id, order_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (order_id) REFERENCES customer_orders(id),
  FOREIGN KEY (order_item_id) REFERENCES order_items(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (id, permission_key, module_name, description)
VALUES (UNHEX(MD5('order.substitute')), 'order.substitute', 'Orders', 'Apply approved grocery substitutions before allocation');
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key='order.substitute'
WHERE r.role_level='TENANT' AND r.is_system=1
  AND r.role_key IN ('tenant_owner','tenant_administrator') AND r.deleted_at IS NULL;
