import { uuidToBuffer as id, bufferToUuid as uuid, createId } from "../../core/identifiers/uuid.js";
import { paymentError } from "./razorpay.js";
import { enqueueTestPaymentInbox } from "../notifications/payment-inbox.events.js";

export async function lockStore({ tenantId, storeId, connection }) {
  const [[row]] = await connection.execute("SELECT id FROM stores WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE", [id(tenantId), id(storeId)]);
  return Boolean(row);
}
export async function settings({ tenantId, storeId, connection }) {
  const [[row]] = await connection.execute(`SELECT s.cod_enabled, s.online_enabled, a.id AS account_id, a.key_id,
    EXISTS(SELECT 1 FROM payment_webhook_secrets w WHERE w.account_id = a.id AND w.expires_at IS NULL) AS webhook_configured
    FROM stores st LEFT JOIN store_payment_settings s ON s.tenant_id = st.tenant_id AND s.store_id = st.id
    LEFT JOIN tenant_payment_settings t ON t.tenant_id = st.tenant_id
    LEFT JOIN tenant_payment_accounts a ON a.id = t.account_id AND a.tenant_id = st.tenant_id
    WHERE st.tenant_id = ? AND st.id = ? AND st.deleted_at IS NULL`, [id(tenantId), id(storeId)]);
  return row ? { codEnabled: row.cod_enabled === null ? true : Boolean(row.cod_enabled), onlineEnabled: Boolean(row.online_enabled),
    accountId: uuid(row.account_id), keyId: row.key_id || "", webhookConfigured: Boolean(row.webhook_configured) } : null;
}
export async function saveSettings({ tenantId, storeId, codEnabled, onlineEnabled, account, webhookEncrypted, connection }) {
  // Serialize tenant-wide credential replacement, including changes from different stores.
  await connection.execute("SELECT id FROM tenants WHERE id = ? FOR UPDATE", [id(tenantId)]);
  if (account) {
    await connection.execute("INSERT INTO tenant_payment_accounts (id, tenant_id, key_id, secret_encrypted) VALUES (?, ?, ?, ?)", [id(account.id), id(tenantId), account.keyId, account.encrypted]);
    await connection.execute("INSERT INTO tenant_payment_settings (tenant_id, account_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE account_id = VALUES(account_id)", [id(tenantId), id(account.id)]);
  }
  if (webhookEncrypted) {
    const [[current]] = await connection.execute("SELECT account_id FROM tenant_payment_settings WHERE tenant_id = ?", [id(tenantId)]);
    if (!current) paymentError("PAYMENT_ACCOUNT_REQUIRED", "Connect a test account before saving its webhook secret.", 422);
    // Keep prior secrets for delayed retries; retain each account's old endpoint during key rotation.
    await connection.execute(`UPDATE payment_webhook_secrets SET expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 25 HOUR)
      WHERE account_id = ? AND expires_at IS NULL`, [current.account_id]);
    await connection.execute("INSERT INTO payment_webhook_secrets (id, account_id, secret_encrypted) VALUES (?, ?, ?)",
      [id(createId()), current.account_id, webhookEncrypted]);
  }
  await connection.execute(`INSERT INTO store_payment_settings (tenant_id, store_id, cod_enabled, online_enabled) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE cod_enabled = VALUES(cod_enabled), online_enabled = VALUES(online_enabled)`, [id(tenantId), id(storeId), codEnabled, onlineEnabled]);
}
export async function audit({ tenantId, storeId, actorUserId, connection }) {
  await connection.execute(`INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type, entity_id, after_data)
    VALUES (?, ?, ?, 'USER', 'PAYMENT_SETTINGS_UPDATED', 'STORE', ?, ?)`,
  [id(createId()), id(tenantId), id(actorUserId), id(storeId), JSON.stringify({ mode: "TEST", credentialsRedacted: true })]);
}
export async function attach({ tenantId, storeId, customerId, order, method, accountId, amountMinor, connection }) {
  const paymentId = createId();
  await connection.execute("UPDATE customer_orders SET payment_method = ? WHERE tenant_id = ? AND id = ?", [method, id(tenantId), id(order.id)]);
  await connection.execute(`INSERT INTO payments (id, tenant_id, customer_order_id, payment_number, payment_method, provider_code,
    status, requested_amount, recorded_manually, metadata) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
  [id(paymentId), id(tenantId), id(order.id), `PAY-${paymentId}`, method, method === "ONLINE_TEST" ? "RAZORPAY_TEST" : null,
    order.grandTotal, method === "COD", JSON.stringify({ testMode: method === "ONLINE_TEST" })]);
  if (method === "ONLINE_TEST") await connection.execute(`INSERT INTO storefront_payment_attempts
    (id, tenant_id, store_id, customer_id, order_id, account_id, payment_id, amount_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [id(createId()), id(tenantId), id(storeId), id(customerId), id(order.id), id(accountId), id(paymentId), amountMinor]);
}
export async function attempt({ tenantId, storeId, customerId, orderId, connection }) {
  const [[row]] = await connection.execute(`SELECT p.*, a.key_id, a.secret_encrypted, o.status AS order_status,
    o.grand_total, o.payment_status FROM storefront_payment_attempts p
    JOIN tenant_payment_accounts a ON a.id = p.account_id AND a.tenant_id = p.tenant_id
    JOIN customer_orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND p.store_id = ? AND p.customer_id = ? AND p.order_id = ? FOR UPDATE`,
  [id(tenantId), id(storeId), id(customerId), id(orderId)]);
  return row ? { id: uuid(row.id), orderId, keyId: row.key_id, encrypted: row.secret_encrypted, amount: Number(row.amount_minor),
    grandTotal: row.grand_total, orderStatus: row.order_status, paymentStatus: row.payment_status,
    paymentId: uuid(row.payment_id), gatewayOrderId: row.gateway_order_id, capturedPaymentId: row.captured_payment_id } : null;
}
export async function saveGatewayOrder({ tenantId, attemptId, gatewayOrderId, connection }) {
  await connection.execute("UPDATE storefront_payment_attempts SET gateway_order_id = ? WHERE tenant_id = ? AND id = ? AND gateway_order_id IS NULL", [gatewayOrderId, id(tenantId), id(attemptId)]);
}
export async function captured({ tenantId, attempt, payment, connection }) {
  const [updated] = await connection.execute("UPDATE storefront_payment_attempts SET captured_payment_id = ? WHERE tenant_id = ? AND id = ? AND captured_payment_id IS NULL", [payment.id, id(tenantId), id(attempt.id)]);
  if (!updated.affectedRows) paymentError("PAYMENT_CAPTURE_CONFLICT", "This payment has already been recorded. Refresh its status.");
  const amount = (attempt.amount / 100).toFixed(2);
  await connection.execute(`UPDATE payments SET status = 'CAPTURED', authorized_amount = ?, captured_amount = ?,
    provider_reference = ?, paid_at = UTC_TIMESTAMP(6) WHERE tenant_id = ? AND id = ?`, [amount, amount, payment.id, id(tenantId), id(attempt.paymentId)]);
  await connection.execute(`INSERT INTO payment_transactions (id, tenant_id, payment_id, transaction_type, provider_transaction_id,
    status, amount, currency, processed_at) VALUES (?, ?, ?, 'CAPTURE', ?, 'SUCCEEDED', ?, 'INR', UTC_TIMESTAMP(6))`,
  [id(createId()), id(tenantId), id(attempt.paymentId), payment.id, amount]);
  // Late capture never revives a cancelled order. It remains visible for refund/reconciliation.
  await connection.execute("UPDATE customer_orders SET payment_status = 'PAID', version = version + 1 WHERE tenant_id = ? AND id = ?", [id(tenantId), id(attempt.orderId)]);
  await connection.execute(`INSERT INTO order_status_history (id, tenant_id, customer_order_id, status_type, previous_status, new_status, notes)
    VALUES (?, ?, ?, 'PAYMENT', 'UNPAID', 'PAID', 'Razorpay TEST capture verified. No real money collected.')`, [id(createId()), id(tenantId), id(attempt.orderId)]);
  await enqueueTestPaymentInbox({ tenantId, attemptId: attempt.id, connection });
}
