import { getPrimaryPool } from "../../database/pool-factory.js";
import {
  createId,
  uuidToBuffer as id,
  bufferToUuid as uuid,
} from "../../core/identifiers/uuid.js";

export async function order({
  tenantId,
  orderId,
  connection = getPrimaryPool(),
  lock = false,
}) {
  const [[row]] = await connection.execute(
    `SELECT co.id,co.store_id,co.order_number,co.status,co.payment_method,
    co.payment_status,co.fulfillment_status,co.grand_total,co.refunded_total,co.currency,co.version,co.placed_at,
    EXISTS(SELECT 1 FROM fulfillments f JOIN seller_orders so ON so.id=f.seller_order_id AND so.tenant_id=f.tenant_id
      WHERE f.tenant_id=co.tenant_id AND so.customer_order_id=co.id AND f.status='COMPLETED') AS delivered,
    EXISTS(SELECT 1 FROM return_requests r WHERE r.tenant_id=co.tenant_id AND r.customer_order_id=co.id AND r.status<>'REJECTED') AS has_returns,
    EXISTS(SELECT 1 FROM refunds r WHERE r.tenant_id=co.tenant_id AND r.customer_order_id=co.id) AS has_refunds
    FROM customer_orders co WHERE co.tenant_id=? AND co.id=?${lock ? " FOR UPDATE" : ""}`,
    [id(tenantId), id(orderId)],
  );
  return row
    ? {
        ...row,
        id: uuid(row.id),
        storeId: uuid(row.store_id),
        version: Number(row.version),
      }
    : null;
}
const receiptSelect = `SELECT c.*,TRIM(CONCAT_WS(' ',u.first_name,u.last_name)) AS recorder_name
  FROM cod_collections c LEFT JOIN users u ON u.id=c.recorded_by`;
export async function collection({
  tenantId,
  orderId,
  requestId,
  connection = getPrimaryPool(),
}) {
  const [[row]] = await connection.execute(
    `${receiptSelect} WHERE c.tenant_id=? AND c.${requestId ? "request_key" : "order_id"}=?`,
    [id(tenantId), id(requestId || orderId)],
  );
  return row || null;
}
const iso = (value) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
export function receipt(row) {
  return row
    ? {
        id: uuid(row.id),
        paymentId: uuid(row.payment_id),
        amount: Number(row.amount),
        currency: row.currency,
        reference: row.collection_reference,
        collectedAt: iso(row.collected_at),
        recordedAt: iso(row.recorded_at),
        notes: row.notes,
        recordedBy: {
          id: uuid(row.recorded_by),
          name: row.recorder_name || "Staff member",
        },
      }
    : null;
}
export async function payments({
  tenantId,
  orderId,
  connection = getPrimaryPool(),
  lock = false,
}) {
  const [rows] = await connection.execute(
    `SELECT id,payment_method,status,currency,authorized_amount,captured_amount,refunded_amount
    FROM payments WHERE tenant_id=? AND customer_order_id=?${lock ? " FOR UPDATE" : ""}`,
    [id(tenantId), id(orderId)],
  );
  return rows;
}
export async function record({
  tenantId,
  order: current,
  input,
  requestHash,
  collectionId,
  paymentId,
  existingPayment,
  context,
  connection,
}) {
  const amount = input.amount,
    at = new Date(input.collectedAt),
    metadata = JSON.stringify({
      codCollectionId: collectionId,
      collectionReference: input.reference,
      testMode: false,
    });
  if (existingPayment)
    await connection.execute(
      `UPDATE payments SET status='CAPTURED',requested_amount=?,authorized_amount=?,captured_amount=?,
    provider_code='MANUAL_COD',provider_reference=?,recorded_manually=1,recorded_by=?,paid_at=?,metadata=? WHERE tenant_id=? AND id=?`,
      [
        amount,
        amount,
        amount,
        `COD-${collectionId}`,
        id(context.actorUserId),
        at,
        metadata,
        id(tenantId),
        id(paymentId),
      ],
    );
  else
    await connection.execute(
      `INSERT INTO payments(id,tenant_id,customer_order_id,payment_number,payment_method,provider_code,provider_reference,
    status,currency,requested_amount,authorized_amount,captured_amount,recorded_manually,recorded_by,paid_at,metadata)
    VALUES(?,?,?,?,'COD','MANUAL_COD',?,'CAPTURED','INR',?,?,?,1,?,?,?)`,
      [
        id(paymentId),
        id(tenantId),
        id(current.id),
        `PAY-${paymentId}`,
        `COD-${collectionId}`,
        amount,
        amount,
        amount,
        id(context.actorUserId),
        at,
        metadata,
      ],
    );
  await connection.execute(
    `INSERT INTO payment_transactions(id,tenant_id,payment_id,transaction_type,provider_transaction_id,status,amount,currency,processed_at)
    VALUES(?,?,?,'CAPTURE',?,'SUCCEEDED',?,'INR',?)`,
    [
      id(createId()),
      id(tenantId),
      id(paymentId),
      `cod_${collectionId.replaceAll("-", "")}`,
      amount,
      at,
    ],
  );
  await connection.execute(
    `INSERT INTO cod_collections(id,tenant_id,order_id,payment_id,request_key,request_hash,amount,collection_reference,collected_at,recorded_by,notes)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id(collectionId),
      id(tenantId),
      id(current.id),
      id(paymentId),
      id(input.requestId),
      requestHash,
      amount,
      input.reference,
      at,
      id(context.actorUserId),
      input.notes,
    ],
  );
  await connection.execute(
    "UPDATE customer_orders SET payment_status='PAID',version=version+1 WHERE tenant_id=? AND id=?",
    [id(tenantId), id(current.id)],
  );
  await connection.execute(
    `INSERT INTO order_status_history(id,tenant_id,customer_order_id,status_type,previous_status,new_status,notes,changed_by)
    VALUES(?,?,?,'PAYMENT',?,'PAID',?,?)`,
    [
      id(createId()),
      id(tenantId),
      id(current.id),
      current.payment_status,
      `Manual COD collection recorded. Reference: ${input.reference}`,
      id(context.actorUserId),
    ],
  );
  await connection.execute(
    `INSERT INTO audit_logs(id,tenant_id,actor_user_id,actor_type,action,entity_type,entity_id,request_id,ip_address,user_agent,before_data,after_data)
    VALUES(?,?,?,'USER','COD_COLLECTION_RECORDED','CUSTOMER_ORDER',?,?,INET6_ATON(?),?,?,?)`,
    [
      id(createId()),
      id(tenantId),
      id(context.actorUserId),
      id(current.id),
      context.requestId || null,
      context.ipAddress || "127.0.0.1",
      context.userAgent || null,
      JSON.stringify({
        paymentStatus: current.payment_status,
        version: current.version,
      }),
      JSON.stringify({
        paymentStatus: "PAID",
        amount,
        currency: "INR",
        collectionId,
        paymentId,
        reference: input.reference,
        collectedAt: input.collectedAt,
        notes: input.notes,
      }),
    ],
  );
}
