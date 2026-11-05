ALTER TABLE specification_definitions
 ADD COLUMN filterable TINYINT(1) NOT NULL DEFAULT 0 AFTER customer_visible,
 ADD KEY ix_specification_discovery(tenant_id,status,customer_visible,filterable),
 ADD CONSTRAINT ck_specification_filter_public CHECK(filterable=0 OR (customer_visible=1 AND data_type IN ('SELECT','BOOLEAN')));
