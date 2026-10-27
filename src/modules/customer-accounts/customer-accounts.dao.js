import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid, uuidToBuffer as id } from "../../core/identifiers/uuid.js";

function account(row) {
  return row ? { customerId: bufferToUuid(row.customer_id), email: row.email, passwordHash: row.password_hash,
    status: row.status, deletedAt: row.deleted_at, firstName: row.first_name, lastName: row.last_name || "", phone: row.phone || "" } : null;
}
export async function lockTenant({ tenantId, connection }) {
  await connection.execute("SELECT id FROM tenants WHERE id = ? FOR UPDATE", [id(tenantId)]);
}
export async function findAccount({ tenantId, email, customerId, connection = getPrimaryPool(), lock = false }) {
  const [rows] = await connection.execute(`SELECT a.*, c.status, c.deleted_at, c.first_name, c.last_name, c.phone
    FROM customer_accounts a JOIN customers c ON c.tenant_id = a.tenant_id AND c.id = a.customer_id
    WHERE a.tenant_id = ? AND ${customerId ? "a.customer_id = ?" : "a.email = ?"} LIMIT 1${lock ? " FOR UPDATE" : ""}`,
  [id(tenantId), customerId ? id(customerId) : email]);
  return account(rows[0]);
}
export async function findCustomers({ tenantId, email, connection }) {
  const [rows] = await connection.execute("SELECT id, email, status, deleted_at FROM customers WHERE tenant_id = ? AND email = ? FOR UPDATE", [id(tenantId), email]);
  return rows.map((row) => ({ id: bufferToUuid(row.id), email: row.email, status: row.status, deletedAt: row.deleted_at }));
}
export async function createAccount({ tenantId, customerId, email, passwordHash, connection }) {
  await connection.execute("INSERT INTO customer_accounts (tenant_id, customer_id, email, password_hash) VALUES (?, ?, ?, ?)", [id(tenantId), id(customerId), email, passwordHash]);
}
export async function insertSession({ tenantId, customerId, tokenHash, connection }) {
  await connection.execute("INSERT INTO customer_sessions (token_hash, tenant_id, customer_id, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 1 HOUR))", [tokenHash, id(tenantId), id(customerId)]);
}
export async function session({ tenantId, tokenHash, connection = getPrimaryPool(), lock = false }) {
  const [rows] = await connection.execute(`SELECT a.*, c.status, c.deleted_at, c.first_name, c.last_name, c.phone
    FROM customer_sessions s JOIN customer_accounts a ON a.tenant_id = s.tenant_id AND a.customer_id = s.customer_id
    JOIN customers c ON c.tenant_id = a.tenant_id AND c.id = a.customer_id
    WHERE s.tenant_id = ? AND s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(6)${lock ? " FOR UPDATE" : ""}`, [id(tenantId), tokenHash]);
  return account(rows[0]);
}
export async function revoke({ tenantId, customerId, tokenHash, connection = getPrimaryPool() }) {
  await connection.execute(`DELETE FROM customer_sessions WHERE tenant_id = ? AND ${customerId ? "customer_id = ?" : "token_hash = ?"}`, [id(tenantId), customerId ? id(customerId) : tokenHash]);
}
export async function insertToken({ tenantId, storeId, email, purpose, tokenHash, firstName = "", lastName = "", customerId, connection }) {
  await connection.execute("DELETE FROM customer_email_tokens WHERE tenant_id = ? AND email = ? AND purpose = ?", [id(tenantId), email, purpose]);
  await connection.execute(`INSERT INTO customer_email_tokens (token_hash, tenant_id, store_id, email, purpose, first_name, last_name, customer_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 MINUTE))`,
  [tokenHash, id(tenantId), id(storeId), email, purpose, firstName, lastName, customerId ? id(customerId) : null]);
}
export async function findToken({ tenantId, storeId, tokenHash, purpose, connection }) {
  const [rows] = await connection.execute(`SELECT * FROM customer_email_tokens WHERE tenant_id = ? AND store_id = ? AND token_hash = ? AND purpose = ? AND expires_at > UTC_TIMESTAMP(6) FOR UPDATE`, [id(tenantId), id(storeId), tokenHash, purpose]);
  const row = rows[0];
  return row ? { email: row.email, firstName: row.first_name, lastName: row.last_name, customerId: row.customer_id ? bufferToUuid(row.customer_id) : null } : null;
}
export async function deleteTokens({ tenantId, email, tokenHash, connection = getPrimaryPool() }) {
  await connection.execute(`DELETE FROM customer_email_tokens WHERE tenant_id = ? AND ${email ? "email = ?" : "token_hash = ?"}`, [id(tenantId), email || tokenHash]);
}
export async function password({ tenantId, customerId, passwordHash, connection }) {
  await connection.execute("UPDATE customer_accounts SET password_hash = ? WHERE tenant_id = ? AND customer_id = ?", [passwordHash, id(tenantId), id(customerId)]);
}
export async function profile({ tenantId, customerId, input, connection }) {
  await connection.execute("UPDATE customers SET first_name = ?, last_name = ?, phone = ? WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL", [input.firstName, input.lastName || null, input.phone || null, id(tenantId), id(customerId)]);
}
export async function limit({ bucketHash, maximum, connection = getPrimaryPool() }) {
  await connection.execute(`INSERT INTO customer_auth_limits (bucket_hash, attempts, expires_at) VALUES (?, 1, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 15 MINUTE))
    ON DUPLICATE KEY UPDATE attempts = IF(expires_at <= UTC_TIMESTAMP(6), 1, attempts + 1),
    expires_at = IF(expires_at <= UTC_TIMESTAMP(6), DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 15 MINUTE), expires_at)`, [bucketHash]);
  const [[row]] = await connection.execute("SELECT attempts FROM customer_auth_limits WHERE bucket_hash = ?", [bucketHash]);
  return row.attempts <= maximum;
}
export async function pruneExpired({ connection = getPrimaryPool() } = {}) {
  await connection.execute("DELETE FROM customer_auth_limits WHERE expires_at <= UTC_TIMESTAMP(6) LIMIT 100");
  await connection.execute("DELETE FROM customer_email_tokens WHERE expires_at <= UTC_TIMESTAMP(6) LIMIT 100");
  await connection.execute("DELETE FROM customer_sessions WHERE expires_at <= UTC_TIMESTAMP(6) LIMIT 100");
}
export async function addresses({ tenantId, customerId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(`SELECT a.*, ca.label, ca.is_default FROM customer_addresses ca JOIN addresses a ON a.id = ca.address_id AND a.tenant_id = ca.tenant_id
    WHERE ca.tenant_id = ? AND ca.customer_id = ? AND ca.address_type = 'SHIPPING' ORDER BY ca.is_default DESC, ca.created_at DESC`, [id(tenantId), id(customerId)]);
  return rows.map((row) => ({ id: bufferToUuid(row.id), label: row.label || "", isDefault: Boolean(row.is_default), contactName: row.contact_name || "", phone: row.phone || "",
    line1: row.line1, line2: row.line2 || "", landmark: row.landmark || "", city: row.city, stateCode: row.state_code, stateName: row.state_name, postalCode: row.postal_code, countryCode: row.country_code }));
}
export async function saveAddress({ tenantId, customerId, addressId, linkId, input, exists, connection }) {
  if (input.isDefault) await connection.execute("UPDATE customer_addresses SET is_default = 0 WHERE tenant_id = ? AND customer_id = ? AND address_type = 'SHIPPING'", [id(tenantId), id(customerId)]);
  const values = [input.contactName, input.phone || null, input.line1, input.line2 || null, input.landmark || null, input.city, input.stateCode, input.stateName, input.postalCode];
  if (exists) {
    await connection.execute(`UPDATE addresses SET contact_name = ?, phone = ?, line1 = ?, line2 = ?, landmark = ?, city = ?, state_code = ?, state_name = ?, postal_code = ? WHERE tenant_id = ? AND id = ?`, [...values, id(tenantId), id(addressId)]);
    await connection.execute("UPDATE customer_addresses SET label = ?, is_default = ? WHERE tenant_id = ? AND customer_id = ? AND address_id = ? AND address_type = 'SHIPPING'", [input.label, input.isDefault, id(tenantId), id(customerId), id(addressId)]);
  } else {
    await connection.execute(`INSERT INTO addresses (contact_name, phone, line1, line2, landmark, city, state_code, state_name, postal_code, id, tenant_id, country_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN')`, [...values, id(addressId), id(tenantId)]);
    await connection.execute("INSERT INTO customer_addresses (id, tenant_id, customer_id, address_id, address_type, label, is_default) VALUES (?, ?, ?, ?, 'SHIPPING', ?, ?)", [id(linkId), id(tenantId), id(customerId), id(addressId), input.label, input.isDefault]);
  }
}
export async function deleteAddress({ tenantId, customerId, addressId, connection }) {
  await connection.execute("DELETE FROM customer_addresses WHERE tenant_id = ? AND customer_id = ? AND address_id = ? AND address_type = 'SHIPPING'", [id(tenantId), id(customerId), id(addressId)]);
}
export async function audit({ tenantId, customerId, action, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_type, action, entity_type, entity_id)
    VALUES (UNHEX(REPLACE(UUID(), '-', '')), ?, 'CUSTOMER', ?, 'CUSTOMER', ?)`, [id(tenantId), action, id(customerId)]);
}
