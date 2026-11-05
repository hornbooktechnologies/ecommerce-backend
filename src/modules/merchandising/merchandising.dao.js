import { getPrimaryPool } from '../../database/pool-factory.js';
import {
  createId,
  uuidToBuffer as id,
  bufferToUuid as uuid,
} from '../../core/identifiers/uuid.js';
import { createHash } from 'node:crypto';
export const hash = (value) => createHash('sha256').update(value).digest();
export async function storeChoices({
  tenantId,
  search = '',
  connection = getPrimaryPool(),
}) {
  const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  const [rows] = await connection.query(
    "SELECT id,name,code FROM stores WHERE tenant_id=? AND deleted_at IS NULL AND (name LIKE ? ESCAPE '\\\\' OR code LIKE ? ESCAPE '\\\\') ORDER BY name,id LIMIT 51",
    [id(tenantId), term, term],
  );
  return {
    items: rows
      .slice(0, 50)
      .map((row) => ({ id: uuid(row.id), name: row.name, code: row.code })),
    hasMore: rows.length > 50,
  };
}
const scopeValues = (s) => [id(s.tenantId), id(s.storeId)];
export async function session({
  tenantId,
  storeId,
  token,
  connection = getPrimaryPool(),
}) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
  const [[row]] = await connection.execute(
    'SELECT id,expires_at FROM merchandising_sessions WHERE tenant_id=? AND store_id=? AND token_hash=? AND enabled=1 AND expires_at>UTC_TIMESTAMP(6)',
    [id(tenantId), id(storeId), hash(token)],
  );
  return row ? { id: uuid(row.id), expiresAt: row.expires_at } : null;
}
export async function enable({
  tenantId,
  storeId,
  token,
  connection = getPrimaryPool(),
}) {
  await connection.execute(
    'INSERT INTO merchandising_sessions(id,tenant_id,store_id,token_hash,expires_at) VALUES(?,?,?,?,DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 24 HOUR))',
    [id(createId()), id(tenantId), id(storeId), hash(token)],
  );
}
export async function disable({
  tenantId,
  storeId,
  token,
  connection = getPrimaryPool(),
}) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) return;
  await connection.execute(
    'UPDATE merchandising_sessions SET enabled=0,token_hash=NULL WHERE tenant_id=? AND store_id=? AND token_hash=?',
    [id(tenantId), id(storeId), hash(token)],
  );
}
export async function scrubExpired({ connection = getPrimaryPool() } = {}) {
  await connection.execute(
    'UPDATE merchandising_sessions SET token_hash=NULL,enabled=0 WHERE expires_at<=UTC_TIMESTAMP(6) AND token_hash IS NOT NULL LIMIT 100',
  );
}
export async function source({
  scope,
  collection,
  sourceKind,
  sourceKey,
  label,
  connection = getPrimaryPool(),
}) {
  const digest = hash(`${sourceKind}:${sourceKey}:${collection.id}`);
  await connection.execute(
    'INSERT INTO merchandising_sources(id,tenant_id,store_id,collection_id,source_hash,kind,source_key,collection_title,source_label) VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id',
    [
      id(createId()),
      ...scopeValues(scope),
      id(collection.id),
      digest,
      sourceKind,
      sourceKey,
      collection.published.title,
      label,
    ],
  );
  const [[row]] = await connection.execute(
    'SELECT id FROM merchandising_sources WHERE tenant_id=? AND store_id=? AND source_hash=?',
    [...scopeValues(scope), digest],
  );
  return uuid(row.id);
}
export async function event({
  scope,
  sessionId,
  sourceId,
  kind,
  productId = null,
  dedupe,
  connection = getPrimaryPool(),
}) {
  const digest = hash(dedupe);
  await connection.execute(
    'INSERT INTO merchandising_events(id,tenant_id,store_id,session_id,source_id,kind,product_id,dedupe_hash) VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE last_seen_at=UTC_TIMESTAMP(6)',
    [
      id(createId()),
      ...scopeValues(scope),
      id(sessionId),
      id(sourceId),
      kind,
      productId ? id(productId) : null,
      digest,
    ],
  );
  const [[row]] = await connection.execute(
    'SELECT id FROM merchandising_events WHERE session_id=? AND dedupe_hash=?',
    [id(sessionId), digest],
  );
  return uuid(row.id);
}
export async function lastOpen({
  scope,
  sessionId,
  collectionId,
  connection = getPrimaryPool(),
}) {
  const [[row]] = await connection.execute(
    "SELECT s.kind,s.source_key FROM merchandising_events e JOIN merchandising_sources s ON s.id=e.source_id AND s.tenant_id=e.tenant_id AND s.store_id=e.store_id WHERE e.tenant_id=? AND e.store_id=? AND e.session_id=? AND s.collection_id=? AND e.kind='OPEN' AND e.last_seen_at>=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 30 MINUTE) ORDER BY e.last_seen_at DESC,e.id DESC LIMIT 1",
    [...scopeValues(scope), id(sessionId), id(collectionId)],
  );
  return row ? { sourceKind: row.kind, sourceKey: row.source_key } : null;
}
export async function lastClick({ scope, sessionId, productId, connection }) {
  const [[row]] = await connection.execute(
    "SELECT id,source_id FROM merchandising_events WHERE tenant_id=? AND store_id=? AND session_id=? AND product_id=? AND kind='CLICK' AND last_seen_at>=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 24 HOUR) ORDER BY last_seen_at DESC,id DESC LIMIT 1",
    [...scopeValues(scope), id(sessionId), id(productId)],
  );
  return row ? { id: uuid(row.id), sourceId: uuid(row.source_id) } : null;
}
export async function convert({
  scope,
  sessionId,
  orderId,
  items,
  connection,
}) {
  for (const line of items) {
    if (!line.merchTouchId) continue;
    await connection.execute(
      `INSERT IGNORE INTO merchandising_order_items(order_item_id,tenant_id,store_id,source_id,touch_id)
   SELECT oi.id,oi.tenant_id,?,e.source_id,e.id FROM order_items oi JOIN seller_offers so ON so.id=oi.offer_id AND so.tenant_id=oi.tenant_id JOIN product_variants pv ON pv.id=so.variant_id AND pv.tenant_id=oi.tenant_id
   JOIN merchandising_events e ON e.id=? AND e.tenant_id=oi.tenant_id AND e.store_id=? AND e.session_id=? AND e.product_id=pv.product_id AND e.kind='CLICK' AND e.last_seen_at>=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 24 HOUR)
   WHERE oi.tenant_id=? AND oi.customer_order_id=? AND oi.offer_id=?`,
      [
        id(scope.storeId),
        id(line.merchTouchId),
        id(scope.storeId),
        id(sessionId),
        id(scope.tenantId),
        id(orderId),
        id(line.offerId),
      ],
    );
  }
}
export async function report({
  scope,
  filters,
  connection = getPrimaryPool(),
}) {
  const from = new Date(`${filters.fromDate}T00:00:00+05:30`)
      .toISOString()
      .slice(0, 23)
      .replace('T', ' '),
    to = new Date(Date.parse(`${filters.toDate}T00:00:00+05:30`) + 86400000)
      .toISOString()
      .slice(0, 23)
      .replace('T', ' ');
  const term = `%${filters.search.replace(/[\\%_]/g, '\\$&')}%`;
  const sourceWhere = `s.tenant_id=? AND s.store_id=? ${filters.kind !== 'ALL' ? 'AND s.kind=?' : ''} AND (s.collection_title LIKE ? ESCAPE '\\\\' OR s.source_label LIKE ? ESCAPE '\\\\')`;
  const args = [
    ...scopeValues(scope),
    ...(filters.kind !== 'ALL' ? [filters.kind] : []),
    term,
    term,
  ];
  // Separate event and order-item facts; never multiply counts by joining both raw fact sets together.
  const events = `SELECT e.source_id,SUM(e.kind='VIEW') views,SUM(e.kind='OPEN') opens,SUM(e.kind='CLICK') clicks,SUM(e.kind='ADD') adds FROM merchandising_events e WHERE e.tenant_id=? AND e.store_id=? AND e.created_at>=? AND e.created_at<? GROUP BY e.source_id`;
  const orderFacts = `SELECT a.source_id,co.id order_id,co.payment_method,co.payment_status,co.refunded_total,oi.line_total FROM merchandising_order_items a JOIN order_items oi ON oi.id=a.order_item_id AND oi.tenant_id=a.tenant_id JOIN customer_orders co ON co.id=oi.customer_order_id AND co.tenant_id=a.tenant_id AND co.store_id=a.store_id WHERE a.tenant_id=? AND a.store_id=? AND co.placed_at>=? AND co.placed_at<? AND co.status NOT IN('DRAFT','CANCELLED') AND oi.status<>'CANCELLED'`;
  const orders = `SELECT f.source_id,COUNT(DISTINCT CASE WHEN COALESCE(f.payment_method,'')<>'ONLINE_TEST' THEN f.order_id END) orders,COUNT(DISTINCT CASE WHEN f.payment_method='ONLINE_TEST' THEN f.order_id END) test_orders,COALESCE(SUM(CASE WHEN f.payment_method='COD' AND f.payment_status='PAID' AND f.refunded_total=0 THEN f.line_total ELSE 0 END),0) paid_value FROM (${orderFacts}) f GROUP BY f.source_id`;
  const where = `${sourceWhere} AND (ev.source_id IS NOT NULL OR cv.source_id IS NOT NULL)`;
  const joined = `FROM merchandising_sources s LEFT JOIN (${events}) ev ON ev.source_id=s.id LEFT JOIN (${orders}) cv ON cv.source_id=s.id WHERE ${where}`;
  const params = [
    ...scopeValues(scope),
    from,
    to,
    ...scopeValues(scope),
    from,
    to,
    ...args,
  ];
  const [rows] = await connection.query(
    `SELECT s.id,s.collection_title,s.source_label,s.kind,s.source_key,COALESCE(ev.views,0) views,COALESCE(ev.opens,0) opens,COALESCE(ev.clicks,0) clicks,COALESCE(ev.adds,0) adds,COALESCE(cv.orders,0) orders,COALESCE(cv.test_orders,0) test_orders,COALESCE(cv.paid_value,0) paid_value ${joined} ORDER BY views DESC,clicks DESC,s.id LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
  );
  const [[totals]] = await connection.query(
    `SELECT COUNT(*) total,COALESCE(SUM(ev.views),0) views,COALESCE(SUM(ev.clicks),0) clicks,COALESCE(SUM(ev.adds),0) adds,COALESCE(SUM(cv.paid_value),0) paid_value ${joined}`,
    params,
  );
  const [[distinct]] = await connection.query(
    `SELECT COUNT(DISTINCT CASE WHEN COALESCE(f.payment_method,'')<>'ONLINE_TEST' THEN f.order_id END) orders,COUNT(DISTINCT CASE WHEN f.payment_method='ONLINE_TEST' THEN f.order_id END) test_orders FROM (${orderFacts}) f JOIN merchandising_sources s ON s.id=f.source_id WHERE ${sourceWhere}`,
    [...scopeValues(scope), from, to, ...args],
  );
  const [trend] = await connection.query(
    `SELECT DATE(DATE_ADD(e.created_at,INTERVAL 330 MINUTE)) day,SUM(e.kind='VIEW') views,SUM(e.kind='CLICK') clicks,SUM(e.kind='ADD') adds FROM merchandising_events e JOIN merchandising_sources s ON s.id=e.source_id WHERE e.tenant_id=? AND e.store_id=? AND e.created_at>=? AND e.created_at<? AND ${sourceWhere} GROUP BY day ORDER BY day`,
    [...scopeValues(scope), from, to, ...args],
  );
  const map = (row) => ({
    id: uuid(row.id),
    collectionTitle: row.collection_title,
    sourceLabel: row.source_label,
    kind: row.kind,
    sourceKey: row.source_key,
    views: Number(row.views),
    opens: Number(row.opens),
    clicks: Number(row.clicks),
    adds: Number(row.adds),
    orders: Number(row.orders),
    testOrders: Number(row.test_orders),
    paidValue: Number(row.paid_value),
  });
  return {
    items: rows.map(map),
    page: filters.page,
    pageSize: filters.pageSize,
    total: Number(totals.total),
    totalPages: Math.max(1, Math.ceil(Number(totals.total) / filters.pageSize)),
    summary: {
      views: Number(totals.views),
      clicks: Number(totals.clicks),
      adds: Number(totals.adds),
      orders: Number(distinct.orders),
      testOrders: Number(distinct.test_orders),
      paidValue: Number(totals.paid_value),
    },
    trend: trend.map((row) => ({
      day:
        row.day instanceof Date
          ? row.day.toISOString().slice(0, 10)
          : String(row.day).slice(0, 10),
      views: Number(row.views),
      clicks: Number(row.clicks),
      adds: Number(row.adds),
    })),
  };
}
