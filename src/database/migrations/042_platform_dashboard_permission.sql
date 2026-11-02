SET NAMES utf8mb4;
INSERT IGNORE INTO permissions(id,permission_key,module_name,description)
VALUES(UNHEX(MD5('platform.dashboard.read')),'platform.dashboard.read','Platform dashboard','View aggregate platform counts');
-- Custom platform roles require an explicit grant through Platform team.
INSERT IGNORE INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.role_level='PLATFORM' AND r.tenant_id IS NULL AND r.role_key='platform_super_admin'
AND r.deleted_at IS NULL AND p.permission_key='platform.dashboard.read';
