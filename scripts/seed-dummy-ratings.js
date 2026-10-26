import { env } from "../src/config/env.js";
import { createId, uuidToBuffer } from "../src/core/identifiers/uuid.js";
import { closePrimaryPool, getPrimaryPool } from "../src/database/pool-factory.js";

const fixtures = [
  { rating: 5, title: "Excellent quality and finish", review: "The product matched the description, arrived well packed, and has held up perfectly in daily use.", status: "PUBLISHED", helpful: 18 },
  { rating: 4, title: "Good product, careful packaging", review: "Quality is very good. Delivery took a little longer than expected, but the item itself is worth it.", status: "PUBLISHED", helpful: 9 },
  { rating: 3, title: "Works as expected", review: "The core product is fine, although the outer packaging could be improved for long-distance delivery.", status: "PENDING", helpful: 2 },
  { rating: 1, title: "Promotional content suspected", review: "Repeated external links and unrelated promotional claims were removed from public view for review.", status: "FLAGGED", helpful: 0, note: "Potential promotional spam; verify before publication." },
  { rating: 2, title: "Review hidden after moderation", review: "This demonstration review contains content that does not meet the workspace publishing policy.", status: "HIDDEN", helpful: 1, note: "Hidden because the text is unrelated to the purchased product." },
  { rating: 5, title: "Would purchase again", review: "Simple ordering experience and the product performs exactly as listed. Recommended for regular use.", status: "PUBLISHED", helpful: 14 }
];

async function main() {
  if (env.nodeEnv === "production") throw new Error("Dummy product ratings cannot be seeded in production.");
  const pool = getPrimaryPool();
  const [scopeRows] = await pool.execute(`SELECT t.id AS tenant_id, t.code AS tenant_code, u.id AS user_id
    FROM tenants t JOIN tenant_memberships tm ON tm.tenant_id = t.id
      AND tm.membership_type = 'OWNER' AND tm.status = 'ACTIVE'
    JOIN users u ON u.id = tm.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
    WHERE t.status = 'ACTIVE' AND t.deleted_at IS NULL ORDER BY t.created_at LIMIT 1`);
  if (!scopeRows[0]) throw new Error("No active tenant owner is available for rating seeding.");
  const scope = scopeRows[0];
  const [products] = await pool.execute(`SELECT id, name FROM products
    WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 12`, [scope.tenant_id]);
  if (!products.length) throw new Error("Create or seed products before seeding product ratings.");
  const [customers] = await pool.execute(`SELECT id, first_name, last_name, email FROM customers
    WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 12`, [scope.tenant_id]);
  const [existingRows] = await pool.execute(`SELECT title FROM product_ratings
    WHERE tenant_id = ? AND source = 'DEVELOPMENT_SEED' AND deleted_at IS NULL`, [scope.tenant_id]);
  const existing = new Set(existingRows.map((row) => row.title)); const created = [];
  for (const [index, fixture] of fixtures.entries()) {
    if (existing.has(fixture.title)) continue;
    const product = products[index % products.length]; const fallbackCustomer = customers[index % Math.max(customers.length, 1)] || null;
    const [purchases] = await pool.execute(`SELECT oi.id AS order_item_id, co.id AS order_id, co.customer_id,
      c.first_name, c.last_name, c.email FROM order_items oi
      JOIN product_variants pv ON pv.id = oi.variant_id
      JOIN customer_orders co ON co.id = oi.customer_order_id
      LEFT JOIN customers c ON c.id = co.customer_id
      WHERE oi.tenant_id = ? AND pv.product_id = ? AND NOT EXISTS
        (SELECT 1 FROM product_ratings used_rating WHERE used_rating.tenant_id = oi.tenant_id
          AND used_rating.order_item_id = oi.id AND used_rating.deleted_at IS NULL)
      ORDER BY co.created_at DESC LIMIT 1`, [scope.tenant_id, product.id]);
    const purchase = purchases[0] || null; const customer = purchase || fallbackCustomer;
    const submittedAt = new Date(Date.now() - (index + 1) * 86400000).toISOString().slice(0, 23).replace("T", " ");
    const moderated = fixture.status !== "PENDING";
    await pool.execute(`INSERT INTO product_ratings (id, tenant_id, product_id, customer_id,
      customer_order_id, order_item_id, rating, title, review_text, customer_name_snapshot,
      customer_email_snapshot, status, source, verified_purchase, helpful_count, moderation_notes,
      moderated_by, moderated_at, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'DEVELOPMENT_SEED', ?, ?, ?, ?, ?, ?)`, [uuidToBuffer(createId()), scope.tenant_id, product.id,
      customer?.customer_id || customer?.id || null, purchase?.order_id || null, purchase?.order_item_id || null,
      fixture.rating, fixture.title, fixture.review,
      customer ? `${customer.first_name || "Demo"}${customer.last_name ? ` ${customer.last_name}` : ""}` : "Demo customer",
      customer?.email || `customer${index + 1}@example.in`, fixture.status, purchase ? 1 : 0, fixture.helpful,
      fixture.note || null, moderated ? scope.user_id : null, moderated ? submittedAt : null, submittedAt]);
    created.push(`${product.name}: ${fixture.title}`);
  }
  const [[summary]] = await pool.execute(`SELECT COUNT(*) AS total,
    SUM(status = 'PUBLISHED') AS published, SUM(status = 'PENDING') AS pending,
    SUM(status = 'FLAGGED') AS flagged, SUM(status = 'HIDDEN') AS hidden
    FROM product_ratings WHERE tenant_id = ? AND deleted_at IS NULL`, [scope.tenant_id]);
  process.stdout.write(`${JSON.stringify({ tenantCode: scope.tenant_code, created, summary }, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; })
  .finally(closePrimaryPool);
