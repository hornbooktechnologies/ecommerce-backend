ALTER TABLE specification_definitions
 DROP CONSTRAINT ck_specification_filter_public,
 ADD CONSTRAINT ck_specification_filter_public CHECK(filterable=0 OR (customer_visible=1 AND data_type IN ('SELECT','BOOLEAN','NUMBER')));
