import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../pool-factory.js";

export async function findHornbookRetailTenant(connection = getPrimaryPool()) {
  const [rows] = await connection.execute(
    `SELECT id, code, display_name, status
       FROM tenants
      WHERE LOWER(display_name) = LOWER('Hornbook Retail')
        AND status = 'ACTIVE' AND deleted_at IS NULL
      LIMIT 1`
  );
  return rows[0] ? {
    id: bufferToUuid(rows[0].id), code: rows[0].code,
    name: rows[0].display_name, status: rows[0].status
  } : null;
}

export async function listAuraProducts({ tenantId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT p.id, p.product_code, p.name, p.approval_status, p.publication_status,
            pv.id AS variant_id, pv.sku
       FROM products p
       LEFT JOIN product_variants pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
      WHERE p.tenant_id = ? AND p.product_code LIKE 'AURA-%' AND p.deleted_at IS NULL
      ORDER BY p.product_code, pv.created_at`,
    [uuidToBuffer(tenantId)]
  );
  return rows.map((row) => ({
    id: bufferToUuid(row.id), productCode: row.product_code, name: row.name,
    approvalStatus: row.approval_status, publicationStatus: row.publication_status,
    variantId: bufferToUuid(row.variant_id), sku: row.sku || null
  }));
}

export async function summarizeAuraImport({ tenantId, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const [[row]] = await connection.execute(
    `SELECT
       (SELECT COUNT(*) FROM products p WHERE p.tenant_id = ? AND p.product_code LIKE 'AURA-%' AND p.deleted_at IS NULL) AS products,
       (SELECT COUNT(*) FROM products p WHERE p.tenant_id = ? AND p.product_code LIKE 'AURA-%'
          AND p.publication_status = 'PUBLISHED' AND p.deleted_at IS NULL) AS published,
       (SELECT COUNT(*) FROM product_variants pv JOIN products p ON p.id = pv.product_id
         WHERE p.tenant_id = ? AND p.product_code LIKE 'AURA-%' AND p.deleted_at IS NULL AND pv.deleted_at IS NULL) AS variants,
       (SELECT COUNT(*) FROM product_media pm JOIN products p ON p.id = pm.product_id
         WHERE p.tenant_id = ? AND p.product_code LIKE 'AURA-%' AND p.deleted_at IS NULL) AS media,
       (SELECT COUNT(*) FROM seller_offers so JOIN product_variants pv ON pv.id = so.variant_id
          JOIN products p ON p.id = pv.product_id WHERE p.tenant_id = ? AND p.product_code LIKE 'AURA-%'
          AND p.deleted_at IS NULL AND pv.deleted_at IS NULL AND so.deleted_at IS NULL) AS offers,
       (SELECT COUNT(*) FROM inventory_balances ib JOIN seller_offers so ON so.id = ib.offer_id
          JOIN product_variants pv ON pv.id = so.variant_id JOIN products p ON p.id = pv.product_id
         WHERE p.tenant_id = ? AND p.product_code LIKE 'AURA-%' AND p.deleted_at IS NULL) AS inventory_balances,
       (SELECT COALESCE(SUM(ib.on_hand_quantity), 0) FROM inventory_balances ib
          JOIN seller_offers so ON so.id = ib.offer_id JOIN product_variants pv ON pv.id = so.variant_id
          JOIN products p ON p.id = pv.product_id WHERE p.tenant_id = ? AND p.product_code LIKE 'AURA-%'
          AND p.deleted_at IS NULL) AS on_hand`,
    [tenant, tenant, tenant, tenant, tenant, tenant, tenant]
  );
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}
