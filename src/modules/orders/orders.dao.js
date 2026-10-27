import { getPrimaryPool } from "../../database/pool-factory.js";
import { bufferToUuid, uuidToBuffer } from "../../core/identifiers/uuid.js";

const number = (value) => value === null || value === undefined ? null : Number(value);
const iso = (value) => value ? new Date(value).toISOString() : null;

function json(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function orderRow(row) {
  return {
    id: bufferToUuid(row.id),
    orderNumber: row.order_number,
    source: row.source,
    externalReference: row.external_reference,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method || null,
    fulfillmentStatus: row.fulfillment_status,
    currency: row.currency,
    subtotal: number(row.subtotal),
    discountTotal: number(row.discount_total),
    shippingTotal: number(row.shipping_total),
    taxTotal: number(row.tax_total),
    roundingTotal: number(row.rounding_total),
    grandTotal: number(row.grand_total),
    refundedTotal: number(row.refunded_total),
    customerName: row.customer_name || "Guest customer",
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    storeName: row.store_name,
    itemCount: Number(row.item_count || 0),
    totalQuantity: number(row.total_quantity) || 0,
    primaryItemName: row.primary_item_name,
    placedAt: iso(row.placed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version || 0)
  };
}

export async function listCreationOptions({ tenantId, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const [storeResult, offerResult, slotResult, promotionResult] = await Promise.all([
    connection.execute(
      `SELECT s.id, s.code, s.name, s.base_currency
         FROM stores s WHERE s.tenant_id = ? AND s.status = 'ACTIVE' AND s.deleted_at IS NULL
        ORDER BY s.created_at`, [tenant]),
    connection.execute(
      `SELECT so.id, so.store_id, so.merchant_id, m.display_name AS merchant_name,
              so.variant_id, p.name AS product_name, pv.name AS variant_name, pv.sku,
              COALESCE(NULLIF(p.hsn_sac_code, ''), NULLIF(tc.hsn_sac_code, '')) AS hsn_sac_code,
              tr.igst_rate AS gst_rate, tr.cess_rate, tr.cess_amount,
              (SELECT gr2.gstin FROM gst_registrations gr2
                WHERE gr2.tenant_id = so.tenant_id AND gr2.status = 'ACTIVE'
                  AND (gr2.effective_from IS NULL OR gr2.effective_from <= UTC_DATE())
                  AND (gr2.effective_to IS NULL OR gr2.effective_to >= UTC_DATE())
                  AND ((m.merchant_type = 'FIRST_PARTY' AND gr2.merchant_id IS NULL
                        AND (gr2.store_id = so.store_id OR gr2.store_id IS NULL))
                    OR (m.merchant_type <> 'FIRST_PARTY' AND gr2.merchant_id = so.merchant_id))
                ORDER BY (gr2.store_id = so.store_id) DESC, gr2.effective_from DESC,
                  gr2.created_at DESC LIMIT 1) AS seller_gstin,
              p.product_kind, pt.vertical, pv.sold_by_weight, pv.minimum_order_quantity,
              pv.maximum_order_quantity, pv.quantity_step, pv.estimated_weight,
              op.list_price, op.sale_price,
              COALESCE((SELECT SUM(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity)
                FROM inventory_balances ib WHERE ib.offer_id = so.id), 0) AS available_quantity,
              (SELECT ma.file_key FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
                WHERE pm.product_id = p.id AND ma.deleted_at IS NULL
                ORDER BY (pm.media_role = 'PRIMARY') DESC, pm.sort_order LIMIT 1) AS image_url
         FROM seller_offers so JOIN merchants m ON m.id = so.merchant_id
         JOIN product_variants pv ON pv.id = so.variant_id AND pv.status = 'ACTIVE' AND pv.deleted_at IS NULL
         JOIN products p ON p.id = pv.product_id AND p.deleted_at IS NULL
         JOIN product_types pt ON pt.id = p.product_type_id AND pt.deleted_at IS NULL
         LEFT JOIN tax_categories tc ON tc.id = p.tax_category_id AND tc.status = 'ACTIVE'
         LEFT JOIN tax_rates tr ON tr.id = (
           SELECT tr2.id FROM tax_rates tr2
            WHERE tr2.tenant_id = so.tenant_id AND tr2.tax_category_id = tc.id
              AND tr2.transaction_type = 'SALE' AND tr2.status = 'ACTIVE'
              AND tr2.state_code IS NULL AND tr2.effective_from <= UTC_DATE()
              AND (tr2.effective_to IS NULL OR tr2.effective_to >= UTC_DATE())
            ORDER BY tr2.effective_from DESC, tr2.created_at DESC LIMIT 1
         )
         JOIN offer_prices op ON op.offer_id = so.id
          AND (op.starts_at IS NULL OR op.starts_at <= UTC_TIMESTAMP())
          AND (op.ends_at IS NULL OR op.ends_at > UTC_TIMESTAMP())
        WHERE so.tenant_id = ? AND so.status <> 'ARCHIVED' AND so.deleted_at IS NULL
        ORDER BY p.name, pv.sku`, [tenant]),
    connection.execute(
      `SELECT dsi.id, dz.store_id, dz.id AS delivery_zone_id, dz.name AS zone_name,
              dsi.starts_at, dsi.ends_at, dsi.order_capacity, dsi.reserved_orders,
              dsi.weight_capacity, dsi.reserved_weight, dz.delivery_fee,
              GROUP_CONCAT(dzpc.postal_code ORDER BY dzpc.postal_code SEPARATOR ',') AS postal_codes
         FROM delivery_slot_instances dsi JOIN delivery_zones dz ON dz.id = dsi.delivery_zone_id
         LEFT JOIN delivery_zone_postal_codes dzpc ON dzpc.delivery_zone_id = dz.id
          AND dzpc.status = 'ACTIVE'
        WHERE dsi.tenant_id = ? AND dsi.status = 'OPEN' AND dz.status = 'ACTIVE'
          AND dsi.starts_at > UTC_TIMESTAMP() AND dsi.reserved_orders < dsi.order_capacity
        GROUP BY dsi.id, dz.store_id, dz.id, dz.name, dsi.starts_at, dsi.ends_at,
          dsi.order_capacity, dsi.reserved_orders, dsi.weight_capacity, dsi.reserved_weight,
          dz.delivery_fee
        ORDER BY dsi.starts_at LIMIT 100`, [tenant]),
    connection.execute(
      `SELECT p.id, p.store_id, p.name, p.promotion_type, p.conditions_json, p.actions_json,
              (SELECT COUNT(*) FROM coupons c WHERE c.promotion_id = p.id AND c.status = 'ACTIVE'
                AND (c.starts_at IS NULL OR c.starts_at <= UTC_TIMESTAMP(6))
                AND (c.ends_at IS NULL OR c.ends_at >= UTC_TIMESTAMP(6))
                AND (c.usage_limit IS NULL OR c.usage_count < c.usage_limit)) AS active_coupon_count
         FROM promotions p WHERE p.tenant_id = ? AND p.status = 'ACTIVE' AND p.deleted_at IS NULL
          AND p.starts_at <= UTC_TIMESTAMP(6) AND (p.ends_at IS NULL OR p.ends_at >= UTC_TIMESTAMP(6))
          AND (p.usage_limit_total IS NULL OR (SELECT COUNT(*) FROM promotion_redemptions pr
            WHERE pr.promotion_id = p.id AND pr.reversed_at IS NULL) < p.usage_limit_total)
        ORDER BY p.priority DESC, p.created_at DESC`, [tenant])
  ]);
  return {
    stores: storeResult[0].map((store) => ({ id: bufferToUuid(store.id), code: store.code,
      name: store.name, currency: store.base_currency })),
    offers: offerResult[0].map((offer) => ({
      id: bufferToUuid(offer.id), storeId: bufferToUuid(offer.store_id),
      merchantId: bufferToUuid(offer.merchant_id), merchantName: offer.merchant_name,
      variantId: bufferToUuid(offer.variant_id), productName: offer.product_name,
      variantName: offer.variant_name, sku: offer.sku, productKind: offer.product_kind,
      vertical: offer.vertical,
      soldByWeight: Boolean(offer.sold_by_weight),
      minimumOrderQuantity: number(offer.minimum_order_quantity) || 1,
      maximumOrderQuantity: number(offer.maximum_order_quantity),
      quantityStep: number(offer.quantity_step) || 1,
      estimatedWeight: number(offer.estimated_weight), listPrice: number(offer.list_price),
      salePrice: number(offer.sale_price), availableQuantity: number(offer.available_quantity) || 0,
      imageUrl: offer.image_url, hsnSacCode: offer.hsn_sac_code || null,
      gstRate: number(offer.gst_rate), cessRate: number(offer.cess_rate) || 0,
      cessAmount: number(offer.cess_amount) || 0,
      hasSellerGstRegistration: Boolean(offer.seller_gstin),
      taxSetupIssues: [!offer.hsn_sac_code && "HSN/SAC code required",
        offer.gst_rate === null && "Current GST slab required",
        !offer.seller_gstin && "Seller GST registration required"].filter(Boolean),
      taxConfigured: Boolean(offer.hsn_sac_code && offer.gst_rate !== null && offer.seller_gstin)
    })),
    deliverySlots: slotResult[0].map((slot) => ({
      id: bufferToUuid(slot.id), storeId: bufferToUuid(slot.store_id),
      zoneId: bufferToUuid(slot.delivery_zone_id), zoneName: slot.zone_name,
      startsAt: iso(slot.starts_at), endsAt: iso(slot.ends_at),
      availableOrders: Number(slot.order_capacity) - Number(slot.reserved_orders),
      availableWeight: slot.weight_capacity === null ? null
        : number(slot.weight_capacity) - number(slot.reserved_weight),
      deliveryFee: number(slot.delivery_fee) || 0,
      postalCodes: slot.postal_codes ? slot.postal_codes.split(",") : []
    })),
    promotions: promotionResult[0].map((promotion) => {
      const conditions = json(promotion.conditions_json, {}); const actions = json(promotion.actions_json, {});
      return { id: bufferToUuid(promotion.id), storeId: bufferToUuid(promotion.store_id), name: promotion.name,
        type: promotion.promotion_type, minimumOrderAmount: Number(conditions.minimumOrderAmount || 0),
        couponRequired: Boolean(conditions.couponRequired), discountValue: Number(actions.discountValue || 0),
        maxDiscountAmount: actions.maxDiscountAmount === null || actions.maxDiscountAmount === undefined
          ? null : Number(actions.maxDiscountAmount), activeCouponCount: Number(promotion.active_coupon_count || 0) };
    })
  };
}

export async function findStoreContext({ tenantId, storeId, connection }) {
  const [rows] = await connection.execute(
    `SELECT s.id, s.name, s.base_currency, s.language_code, s.timezone,
            a.state_code AS origin_state_code
       FROM stores s LEFT JOIN addresses a ON a.id = s.business_address_id
      WHERE s.tenant_id = ? AND s.id = ? AND s.status = 'ACTIVE' AND s.deleted_at IS NULL LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(storeId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), name: rows[0].name,
    currency: rows[0].base_currency, language: rows[0].language_code,
    timezone: rows[0].timezone, originStateCode: rows[0].origin_state_code } : null;
}

export async function findOffersForOrder({ tenantId, storeId, offerIds, destinationStateCode, connection }) {
  if (!offerIds.length) return [];
  const placeholders = offerIds.map(() => "?").join(", ");
  const [rows] = await connection.execute(
    `SELECT so.id, so.store_id, so.merchant_id, so.variant_id, so.seller_sku,
            so.minimum_order_quantity AS offer_minimum_quantity,
            so.maximum_order_quantity AS offer_maximum_quantity,
            m.display_name AS merchant_name, m.merchant_type,
            p.name AS product_name, p.product_kind,
            COALESCE(NULLIF(p.hsn_sac_code, ''), NULLIF(tc.hsn_sac_code, '')) AS hsn_sac_code,
            tc.id AS tax_category_id, tr.id AS tax_rate_id,
            tr.cgst_rate, tr.sgst_rate, tr.igst_rate, tr.cess_rate, tr.cess_amount,
            gr.gstin, gr.state_code AS registration_state_code,
            pv.name AS variant_name, pv.sku, pv.sold_by_weight,
            pv.minimum_order_quantity, pv.maximum_order_quantity, pv.quantity_step,
            pv.estimated_weight, pt.vertical, op.list_price, op.sale_price,
            COALESCE((SELECT SUM(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity)
              FROM inventory_balances ib WHERE ib.offer_id = so.id), 0) AS available_quantity,
            (SELECT ma.file_key FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
              WHERE pm.product_id = p.id AND ma.deleted_at IS NULL
              ORDER BY (pm.media_role = 'PRIMARY') DESC, pm.sort_order LIMIT 1) AS image_url
       FROM seller_offers so JOIN merchants m ON m.id = so.merchant_id
       JOIN product_variants pv ON pv.id = so.variant_id AND pv.deleted_at IS NULL
       JOIN products p ON p.id = pv.product_id AND p.deleted_at IS NULL
       JOIN product_types pt ON pt.id = p.product_type_id AND pt.deleted_at IS NULL
       LEFT JOIN tax_categories tc ON tc.id = p.tax_category_id AND tc.status = 'ACTIVE'
       LEFT JOIN tax_rates tr ON tr.id = (
         SELECT tr2.id FROM tax_rates tr2
          WHERE tr2.tenant_id = so.tenant_id AND tr2.tax_category_id = tc.id
            AND tr2.transaction_type = 'SALE' AND tr2.status = 'ACTIVE'
            AND (tr2.state_code = ? OR tr2.state_code IS NULL)
            AND tr2.effective_from <= UTC_DATE()
            AND (tr2.effective_to IS NULL OR tr2.effective_to >= UTC_DATE())
          ORDER BY (tr2.state_code = ?) DESC, tr2.effective_from DESC, tr2.created_at DESC LIMIT 1
       )
       LEFT JOIN gst_registrations gr ON gr.id = (
         SELECT gr2.id FROM gst_registrations gr2
          WHERE gr2.tenant_id = so.tenant_id AND gr2.status = 'ACTIVE'
            AND (gr2.effective_from IS NULL OR gr2.effective_from <= UTC_DATE())
            AND (gr2.effective_to IS NULL OR gr2.effective_to >= UTC_DATE())
            AND ((m.merchant_type = 'FIRST_PARTY' AND gr2.merchant_id IS NULL
                  AND (gr2.store_id = so.store_id OR gr2.store_id IS NULL))
              OR (m.merchant_type <> 'FIRST_PARTY' AND gr2.merchant_id = so.merchant_id))
          ORDER BY (gr2.store_id = so.store_id) DESC, gr2.effective_from DESC, gr2.created_at DESC LIMIT 1
       )
       JOIN offer_prices op ON op.offer_id = so.id
        AND (op.starts_at IS NULL OR op.starts_at <= UTC_TIMESTAMP())
        AND (op.ends_at IS NULL OR op.ends_at > UTC_TIMESTAMP())
      WHERE so.tenant_id = ? AND so.store_id = ? AND so.id IN (${placeholders})
        AND so.status <> 'ARCHIVED' AND so.deleted_at IS NULL`,
    [destinationStateCode, destinationStateCode, uuidToBuffer(tenantId), uuidToBuffer(storeId),
      ...offerIds.map(uuidToBuffer)]
  );
  return rows.map((row) => ({
    id: bufferToUuid(row.id), storeId: bufferToUuid(row.store_id),
    merchantId: bufferToUuid(row.merchant_id), merchantName: row.merchant_name,
    variantId: bufferToUuid(row.variant_id), productName: row.product_name,
    variantName: row.variant_name, sku: row.sku, sellerSku: row.seller_sku,
    hsnSacCode: row.hsn_sac_code, productKind: row.product_kind, vertical: row.vertical,
    merchantType: row.merchant_type, taxCategoryId: bufferToUuid(row.tax_category_id),
    taxRateId: bufferToUuid(row.tax_rate_id), registrationGstin: row.gstin || null,
    registrationStateCode: row.registration_state_code || null,
    cgstRate: number(row.cgst_rate), sgstRate: number(row.sgst_rate),
    igstRate: number(row.igst_rate), cessRate: number(row.cess_rate) || 0,
    cessAmount: number(row.cess_amount) || 0,
    soldByWeight: Boolean(row.sold_by_weight),
    minimumOrderQuantity: number(row.offer_minimum_quantity) || number(row.minimum_order_quantity) || 1,
    maximumOrderQuantity: number(row.offer_maximum_quantity) || number(row.maximum_order_quantity),
    quantityStep: number(row.quantity_step) || 1, estimatedWeight: number(row.estimated_weight),
    listPrice: number(row.list_price), salePrice: number(row.sale_price),
    availableQuantity: number(row.available_quantity) || 0, imageUrl: row.image_url
  }));
}

export async function listRequiredBundleComponents({ tenantId, bundleVariantId, merchantId,
  storeId, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT pbc.id, pbc.component_variant_id, pbc.quantity, pbc.sort_order,
            cp.name AS product_name, cp.product_kind, cv.name AS variant_name, cv.sku,
            cpt.lot_tracking_enabled, cpt.serial_tracking_enabled,
            cpt.expiry_tracking_enabled, cv.warranty_months, cv.warranty_type,
            cso.id AS component_offer_id,
            COALESCE((SELECT SUM(ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity)
              FROM inventory_balances ib WHERE ib.offer_id = cso.id), 0) AS available_quantity
       FROM product_bundle_components pbc
       JOIN product_variants cv ON cv.id = pbc.component_variant_id
        AND cv.status = 'ACTIVE' AND cv.deleted_at IS NULL
       JOIN products cp ON cp.id = cv.product_id AND cp.deleted_at IS NULL
       JOIN product_types cpt ON cpt.id = cp.product_type_id AND cpt.deleted_at IS NULL
       LEFT JOIN seller_offers cso ON cso.id = (
         SELECT candidate.id FROM seller_offers candidate
          WHERE candidate.tenant_id = pbc.tenant_id
            AND candidate.variant_id = pbc.component_variant_id
            AND candidate.merchant_id = ? AND candidate.store_id = ?
            AND candidate.status = 'ACTIVE' AND candidate.deleted_at IS NULL
          ORDER BY candidate.created_at, candidate.id LIMIT 1
       )
      WHERE pbc.tenant_id = ? AND pbc.bundle_variant_id = ? AND pbc.is_optional = 0
      ORDER BY pbc.sort_order, cp.name, cv.sku`,
    [uuidToBuffer(merchantId), uuidToBuffer(storeId), uuidToBuffer(tenantId),
      uuidToBuffer(bundleVariantId)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id),
    componentVariantId: bufferToUuid(row.component_variant_id), quantity: number(row.quantity),
    sortOrder: Number(row.sort_order), productName: row.product_name,
    productKind: row.product_kind, variantName: row.variant_name, sku: row.sku,
    offerId: row.component_offer_id ? bufferToUuid(row.component_offer_id) : null,
    availableQuantity: number(row.available_quantity) || 0,
    lotTracking: Boolean(row.lot_tracking_enabled), serialTracking: Boolean(row.serial_tracking_enabled),
    expiryTracking: Boolean(row.expiry_tracking_enabled),
    warrantyMonths: row.warranty_months === null ? null : Number(row.warranty_months),
    warrantyType: row.warranty_type }));
}

export async function findCustomer({ tenantId, email, phone, connection }) {
  const conditions = [];
  const parameters = [uuidToBuffer(tenantId)];
  if (email) { conditions.push("email = ?"); parameters.push(email); }
  if (phone) { conditions.push("phone = ?"); parameters.push(phone); }
  if (!conditions.length) return null;
  const [rows] = await connection.execute(
    `SELECT id FROM customers WHERE tenant_id = ? AND (${conditions.join(" OR ")})
      AND status = 'ACTIVE' AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, parameters
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id) } : null;
}

export async function insertCustomer({ customer, connection }) {
  await connection.execute(
    `INSERT INTO customers (id, tenant_id, customer_number, first_name, last_name,
       email, phone, customer_type, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'INDIVIDUAL', 'ACTIVE', ?)`,
    [uuidToBuffer(customer.id), uuidToBuffer(customer.tenantId), customer.number,
      customer.firstName, customer.lastName || null, customer.email || null,
      customer.phone || null, customer.notes || null]
  );
}

export async function findPromotionForOrder({ tenantId, storeId, promotionId, customerId,
  couponCode, connection }) {
  const [rows] = await connection.execute(
    `SELECT p.id, p.name, p.promotion_type, p.usage_limit_total,
            p.usage_limit_per_customer, p.conditions_json, p.actions_json,
            (SELECT COUNT(*) FROM promotion_redemptions pr WHERE pr.promotion_id = p.id
              AND pr.reversed_at IS NULL) AS redemption_count,
            (SELECT COUNT(*) FROM promotion_redemptions pr WHERE pr.promotion_id = p.id
              AND pr.customer_id = ? AND pr.reversed_at IS NULL) AS customer_redemption_count
       FROM promotions p WHERE p.tenant_id = ? AND p.id = ? AND p.status = 'ACTIVE'
        AND p.deleted_at IS NULL AND (p.store_id IS NULL OR p.store_id = ?)
        AND p.starts_at <= UTC_TIMESTAMP(6) AND (p.ends_at IS NULL OR p.ends_at >= UTC_TIMESTAMP(6))
      LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(customerId), uuidToBuffer(tenantId), uuidToBuffer(promotionId), uuidToBuffer(storeId)]
  );
  if (!rows[0]) return null;
  let coupon = null;
  if (couponCode) {
    const [couponRows] = await connection.execute(
      `SELECT id, code, status, usage_limit, usage_count, starts_at, ends_at FROM coupons
        WHERE tenant_id = ? AND promotion_id = ? AND code = ? LIMIT 1 FOR UPDATE`,
      [uuidToBuffer(tenantId), uuidToBuffer(promotionId), couponCode]
    );
    if (couponRows[0]) coupon = { id: bufferToUuid(couponRows[0].id), code: couponRows[0].code,
      status: couponRows[0].status, usageLimit: number(couponRows[0].usage_limit),
      usageCount: Number(couponRows[0].usage_count || 0), startsAt: iso(couponRows[0].starts_at),
      endsAt: iso(couponRows[0].ends_at) };
  }
  const row = rows[0]; const conditions = json(row.conditions_json, {}); const actions = json(row.actions_json, {});
  return { id: bufferToUuid(row.id), name: row.name, type: row.promotion_type,
    usageLimitTotal: number(row.usage_limit_total), usageLimitPerCustomer: number(row.usage_limit_per_customer),
    redemptionCount: Number(row.redemption_count || 0), customerRedemptionCount: Number(row.customer_redemption_count || 0),
    minimumOrderAmount: Number(conditions.minimumOrderAmount || 0), couponRequired: Boolean(conditions.couponRequired),
    discountValue: Number(actions.discountValue || 0), maxDiscountAmount: actions.maxDiscountAmount === null
      || actions.maxDiscountAmount === undefined ? null : Number(actions.maxDiscountAmount), coupon };
}

export async function insertPromotionRedemption({ redemption, connection }) {
  await connection.execute(`INSERT INTO promotion_redemptions (id, tenant_id, promotion_id, coupon_id,
    customer_order_id, customer_id, discount_amount) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [uuidToBuffer(redemption.id), uuidToBuffer(redemption.tenantId), uuidToBuffer(redemption.promotionId),
    redemption.couponId ? uuidToBuffer(redemption.couponId) : null, uuidToBuffer(redemption.orderId),
    uuidToBuffer(redemption.customerId), redemption.discountAmount]);
  if (redemption.couponId) await connection.execute(
    `UPDATE coupons SET usage_count = usage_count + 1 WHERE id = ?`, [uuidToBuffer(redemption.couponId)]);
}

export async function reversePromotionRedemption({ tenantId, orderId, connection }) {
  const [rows] = await connection.execute(`SELECT id, coupon_id FROM promotion_redemptions
    WHERE tenant_id = ? AND customer_order_id = ? AND reversed_at IS NULL FOR UPDATE`,
  [uuidToBuffer(tenantId), uuidToBuffer(orderId)]);
  if (!rows.length) return;
  await connection.execute(`UPDATE promotion_redemptions SET reversed_at = UTC_TIMESTAMP(6)
    WHERE tenant_id = ? AND customer_order_id = ? AND reversed_at IS NULL`,
  [uuidToBuffer(tenantId), uuidToBuffer(orderId)]);
  for (const row of rows) if (row.coupon_id) await connection.execute(
    `UPDATE coupons SET usage_count = GREATEST(usage_count - 1, 0) WHERE id = ?`, [row.coupon_id]);
}

export async function nextDocumentNumber({ tenantId, storeId, type, connection }) {
  const [rows] = await connection.execute(
    `SELECT id, prefix, next_number, number_padding FROM number_sequences
      WHERE tenant_id = ? AND store_id = ? AND sequence_type = ?
      ORDER BY financial_year IS NULL DESC, financial_year DESC LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(storeId), type]
  );
  if (!rows[0]) return null;
  await connection.execute(
    "UPDATE number_sequences SET next_number = next_number + 1, version = version + 1 WHERE id = ?",
    [rows[0].id]
  );
  const prefix = String(rows[0].prefix);
  const separator = prefix.endsWith("-") ? "" : "-";
  return `${prefix}${separator}${String(rows[0].next_number).padStart(Number(rows[0].number_padding), "0")}`;
}

export async function findDeliverySlotForUpdate({ tenantId, storeId, slotId, postalCode, connection }) {
  if (!slotId) return null;
  const [rows] = await connection.execute(
    `SELECT dsi.id, dsi.delivery_zone_id, dsi.order_capacity, dsi.reserved_orders,
            dsi.weight_capacity, dsi.reserved_weight, dz.delivery_fee,
            EXISTS(SELECT 1 FROM delivery_zone_postal_codes dzpc
              WHERE dzpc.delivery_zone_id = dz.id AND dzpc.postal_code = ?
                AND dzpc.status = 'ACTIVE') AS postal_supported,
            EXISTS(SELECT 1 FROM delivery_zone_postal_codes dzpc
              WHERE dzpc.delivery_zone_id = dz.id AND dzpc.status = 'ACTIVE') AS has_postal_rules
       FROM delivery_slot_instances dsi JOIN delivery_zones dz ON dz.id = dsi.delivery_zone_id
      WHERE dsi.tenant_id = ? AND dsi.id = ? AND dz.store_id = ?
        AND dsi.status = 'OPEN' AND dz.status = 'ACTIVE' AND dsi.starts_at > UTC_TIMESTAMP()
      LIMIT 1 FOR UPDATE`,
    [postalCode, uuidToBuffer(tenantId), uuidToBuffer(slotId), uuidToBuffer(storeId)]
  );
  if (!rows[0]) return null;
  return { id: bufferToUuid(rows[0].id), zoneId: bufferToUuid(rows[0].delivery_zone_id),
    orderCapacity: Number(rows[0].order_capacity), reservedOrders: Number(rows[0].reserved_orders),
    weightCapacity: number(rows[0].weight_capacity), reservedWeight: number(rows[0].reserved_weight) || 0,
    deliveryFee: number(rows[0].delivery_fee) || 0,
    postalSupported: Boolean(rows[0].postal_supported), hasPostalRules: Boolean(rows[0].has_postal_rules) };
}

export async function reserveDeliverySlot({ tenantId, slot, orderId, weight, connection }) {
  await connection.execute(
    `UPDATE delivery_slot_instances SET reserved_orders = reserved_orders + 1,
       reserved_weight = reserved_weight + ?, version = version + 1
      WHERE tenant_id = ? AND id = ?`, [weight, uuidToBuffer(tenantId), uuidToBuffer(slot.id)]
  );
  await connection.execute(
    `INSERT INTO delivery_slot_reservations (id, tenant_id, delivery_slot_instance_id,
       customer_order_id, reserved_weight, status)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
    [uuidToBuffer(slot.reservationId), uuidToBuffer(tenantId), uuidToBuffer(slot.id),
      uuidToBuffer(orderId), weight]
  );
}

export async function insertOrder({ order, connection }) {
  await connection.execute(
    `INSERT INTO customer_orders (id, tenant_id, store_id, customer_id, delivery_slot_instance_id,
       order_number, source, status, payment_status, fulfillment_status, currency, prices_include_tax,
       subtotal, discount_total, shipping_total, tax_total, rounding_total, grand_total,
       billing_address_snapshot, shipping_address_snapshot, customer_snapshot, customer_notes,
       internal_notes, placed_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PLACED', 'UNPAID', 'UNFULFILLED', ?, 1,
       ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), ?)`,
    [uuidToBuffer(order.id), uuidToBuffer(order.tenantId), uuidToBuffer(order.storeId),
      uuidToBuffer(order.customerId), order.deliverySlotId ? uuidToBuffer(order.deliverySlotId) : null,
      order.number, order.source || "MANUAL", order.currency, order.subtotal, order.discountTotal, order.shippingTotal,
      order.taxTotal, order.grandTotal, JSON.stringify(order.billingAddress),
      JSON.stringify(order.shippingAddress), JSON.stringify(order.customerSnapshot),
      order.customerNotes || null, order.internalNotes || null, order.actorUserId ? uuidToBuffer(order.actorUserId) : null]
  );
}

export async function insertSellerOrder({ sellerOrder, connection }) {
  await connection.execute(
    `INSERT INTO seller_orders (id, tenant_id, customer_order_id, merchant_id,
       seller_order_number, status, fulfillment_status, payment_allocation_status,
       subtotal, discount_total, shipping_total, tax_total, grand_total, merchant_payable_total)
     VALUES (?, ?, ?, ?, ?, 'PENDING', 'UNFULFILLED', 'PENDING', ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(sellerOrder.id), uuidToBuffer(sellerOrder.tenantId),
      uuidToBuffer(sellerOrder.orderId), uuidToBuffer(sellerOrder.merchantId), sellerOrder.number,
      sellerOrder.subtotal, sellerOrder.discountTotal, sellerOrder.shippingTotal,
      sellerOrder.taxTotal, sellerOrder.grandTotal, sellerOrder.merchantPayableTotal]
  );
}

export async function insertOrderItem({ item, connection }) {
  await connection.execute(
    `INSERT INTO order_items (id, tenant_id, customer_order_id, seller_order_id,
       offer_id, variant_id, product_name, variant_name, sku, hsn_sac_code, quantity,
       estimated_weight, unit_price, list_price, discount_total, taxable_amount,
       cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount,
       cess_rate, cess_amount, tax_total, line_total, substitution_preference,
       product_snapshot, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, 'PENDING')`,
    [uuidToBuffer(item.id), uuidToBuffer(item.tenantId), uuidToBuffer(item.orderId),
      uuidToBuffer(item.sellerOrderId), uuidToBuffer(item.offerId), uuidToBuffer(item.variantId),
      item.productName, item.variantName || null, item.sku, item.hsnSacCode || null,
      item.quantity, item.estimatedWeight, item.unitPrice, item.listPrice,
      item.discountTotal, item.taxableAmount, item.cgstRate, item.cgstAmount,
      item.sgstRate, item.sgstAmount, item.igstRate, item.igstAmount,
      item.cessRate, item.cessAmount, item.taxTotal, item.lineTotal,
      item.substitutionPreference || null, JSON.stringify(item.productSnapshot)]
  );
}

export async function insertOrderItemBundleComponent({ component, connection }) {
  await connection.execute(
    `INSERT INTO order_item_bundle_components (id, tenant_id, order_item_id,
       component_variant_id, component_offer_id, product_name, variant_name, sku,
       quantity_per_bundle, total_quantity, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(component.id), uuidToBuffer(component.tenantId),
      uuidToBuffer(component.orderItemId), uuidToBuffer(component.variantId),
      uuidToBuffer(component.offerId), component.productName, component.variantName || null,
      component.sku, component.quantityPerBundle, component.totalQuantity, component.sortOrder]
  );
}

export async function listOrders({ tenantId, filters, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const where = ["co.tenant_id = ?"];
  const parameters = [tenant];
  if (filters.search) {
    const term = `%${filters.search}%`;
    where.push(`(co.order_number LIKE ? OR co.external_reference LIKE ? OR
      CONCAT_WS(' ', c.first_name, c.last_name) LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)`);
    parameters.push(term, term, term, term, term);
  }
  if (filters.status !== "ALL") {
    where.push("co.status = ?");
    parameters.push(filters.status);
  }
  if (filters.paymentStatus !== "ALL") {
    where.push("co.payment_status = ?");
    parameters.push(filters.paymentStatus);
  }
  if (filters.fulfillmentStatus !== "ALL") {
    where.push("co.fulfillment_status = ?");
    parameters.push(filters.fulfillmentStatus);
  }
  const whereSql = where.join(" AND ");
  const offset = (filters.page - 1) * filters.pageSize;
  const [rowsResult, countResult, summaryResult] = await Promise.all([
    connection.execute(
      `SELECT co.id, co.order_number, co.source, co.external_reference, co.status,
              co.payment_status, co.payment_method, co.fulfillment_status, co.currency, co.subtotal,
              co.discount_total, co.shipping_total, co.tax_total, co.rounding_total,
              co.grand_total, co.refunded_total, co.placed_at, co.created_at,
              co.updated_at, co.version, s.name AS store_name,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
                JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.name'))) AS customer_name,
              COALESCE(c.email, JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.email'))) AS customer_email,
              COALESCE(c.phone, JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.phone'))) AS customer_phone,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.customer_order_id = co.id) AS item_count,
              (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.customer_order_id = co.id) AS total_quantity,
              (SELECT oi.product_name FROM order_items oi WHERE oi.customer_order_id = co.id
                ORDER BY oi.created_at, oi.id LIMIT 1) AS primary_item_name
         FROM customer_orders co
         JOIN stores s ON s.id = co.store_id
         LEFT JOIN customers c ON c.id = co.customer_id
        WHERE ${whereSql}
        ORDER BY COALESCE(co.placed_at, co.created_at) DESC, co.created_at DESC
        LIMIT ? OFFSET ?`, [...parameters, filters.pageSize, offset]),
    connection.execute(
      `SELECT COUNT(*) AS total FROM customer_orders co
       LEFT JOIN customers c ON c.id = co.customer_id WHERE ${whereSql}`, parameters),
    connection.execute(
      `SELECT COUNT(*) AS total,
              SUM(co.created_at >= UTC_DATE()) AS new_today,
              SUM(co.status IN ('PLACED', 'CONFIRMED', 'PROCESSING')) AS in_progress,
              SUM(co.status = 'CANCELLED') AS cancelled,
              COALESCE(SUM(CASE WHEN co.status = 'COMPLETED'
                AND co.completed_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
                THEN co.grand_total ELSE 0 END), 0) AS revenue_30d
         FROM customer_orders co WHERE co.tenant_id = ?`, [tenant])
  ]);
  const rows = rowsResult[0];
  const total = Number(countResult[0][0].total);
  const summary = summaryResult[0][0];
  return {
    items: rows.map(orderRow), total, page: filters.page, pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
    summary: {
      total: Number(summary.total || 0), newToday: Number(summary.new_today || 0),
      inProgress: Number(summary.in_progress || 0), cancelled: Number(summary.cancelled || 0),
      revenue30d: number(summary.revenue_30d) || 0
    }
  };
}

export async function getOrder({ tenantId, orderId, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const id = uuidToBuffer(orderId);
  const [orderResult, itemResult, sellerResult, historyResult, fulfillmentResult] = await Promise.all([
    connection.execute(
      `SELECT co.*, s.name AS store_name,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
                JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.name'))) AS customer_name,
              COALESCE(c.email, JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.email'))) AS customer_email,
              COALESCE(c.phone, JSON_UNQUOTE(JSON_EXTRACT(co.customer_snapshot, '$.phone'))) AS customer_phone,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.customer_order_id = co.id) AS item_count,
              (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.customer_order_id = co.id) AS total_quantity,
              (SELECT oi.product_name FROM order_items oi WHERE oi.customer_order_id = co.id
                ORDER BY oi.created_at, oi.id LIMIT 1) AS primary_item_name
         FROM customer_orders co JOIN stores s ON s.id = co.store_id
         LEFT JOIN customers c ON c.id = co.customer_id
        WHERE co.tenant_id = ? AND co.id = ? LIMIT 1`, [tenant, id]),
    connection.execute(
      `SELECT oi.id, oi.seller_order_id, oi.product_name, oi.variant_name, oi.sku,
              oi.quantity, oi.estimated_weight, oi.actual_weight, oi.unit_price, oi.list_price,
              oi.discount_total, oi.taxable_amount, oi.tax_total, oi.line_total,
              oi.substitution_preference, oi.product_snapshot, oi.status,
              m.display_name AS merchant_name
         FROM order_items oi JOIN seller_orders so ON so.id = oi.seller_order_id
         JOIN merchants m ON m.id = so.merchant_id
        WHERE oi.tenant_id = ? AND oi.customer_order_id = ? ORDER BY oi.created_at, oi.id`, [tenant, id]),
    connection.execute(
      `SELECT so.id, so.seller_order_number, so.status, so.fulfillment_status,
              so.payment_allocation_status, so.grand_total, so.merchant_payable_total,
              m.display_name AS merchant_name
         FROM seller_orders so JOIN merchants m ON m.id = so.merchant_id
        WHERE so.tenant_id = ? AND so.customer_order_id = ? ORDER BY so.created_at`, [tenant, id]),
    connection.execute(
      `SELECT osh.id, osh.status_type, osh.previous_status, osh.new_status,
              osh.reason_code, osh.notes, osh.changed_at,
              TRIM(CONCAT_WS(' ', u.first_name, u.last_name)) AS changed_by_name
         FROM order_status_history osh LEFT JOIN users u ON u.id = osh.changed_by
        WHERE osh.tenant_id = ? AND osh.customer_order_id = ?
        ORDER BY osh.changed_at DESC, osh.id DESC`, [tenant, id]),
    connection.execute(
      `SELECT f.id, f.seller_order_id, f.warehouse_id, f.fulfillment_number, f.status,
              f.fulfillment_type, f.picking_started_at, f.packed_at, f.dispatched_at,
              f.completed_at, f.notes, w.name AS warehouse_name,
              so.seller_order_number, m.display_name AS merchant_name,
              sh.id AS shipment_id, sh.shipment_number, sh.provider_code, sh.service_code,
              sh.tracking_number, sh.status AS shipment_status, sh.package_count,
              sh.package_weight, sh.shipped_at, sh.delivered_at,
              (SELECT COUNT(*) FROM fulfillment_items fi WHERE fi.fulfillment_id = f.id) AS item_count
         FROM fulfillments f JOIN warehouses w ON w.id = f.warehouse_id
         JOIN seller_orders so ON so.id = f.seller_order_id
         JOIN merchants m ON m.id = so.merchant_id
         LEFT JOIN shipments sh ON sh.fulfillment_id = f.id
        WHERE f.tenant_id = ? AND so.customer_order_id = ?
        ORDER BY f.created_at`, [tenant, id])
  ]);
  const row = orderResult[0][0];
  if (!row) return null;
  return {
    order: {
      ...orderRow(row),
      customerNotes: row.customer_notes,
      internalNotes: row.internal_notes,
      customer: json(row.customer_snapshot, {}),
      billingAddress: json(row.billing_address_snapshot, {}),
      shippingAddress: json(row.shipping_address_snapshot, {})
    },
    items: itemResult[0].map((item) => ({
      id: bufferToUuid(item.id), sellerOrderId: bufferToUuid(item.seller_order_id),
      productName: item.product_name, variantName: item.variant_name, sku: item.sku,
      quantity: number(item.quantity), estimatedWeight: number(item.estimated_weight),
      actualWeight: number(item.actual_weight), unitPrice: number(item.unit_price),
      listPrice: number(item.list_price), discountTotal: number(item.discount_total),
      taxableAmount: number(item.taxable_amount), taxTotal: number(item.tax_total),
      lineTotal: number(item.line_total), substitutionPreference: item.substitution_preference,
      product: json(item.product_snapshot, {}), status: item.status,
      merchantName: item.merchant_name
    })),
    sellerOrders: sellerResult[0].map((seller) => ({
      id: bufferToUuid(seller.id), number: seller.seller_order_number,
      status: seller.status, fulfillmentStatus: seller.fulfillment_status,
      paymentAllocationStatus: seller.payment_allocation_status,
      grandTotal: number(seller.grand_total), merchantPayableTotal: number(seller.merchant_payable_total),
      merchantName: seller.merchant_name
    })),
    history: historyResult[0].map((entry) => ({
      id: bufferToUuid(entry.id), type: entry.status_type,
      previousStatus: entry.previous_status, newStatus: entry.new_status,
      reasonCode: entry.reason_code, notes: entry.notes,
      changedBy: entry.changed_by_name || "System", changedAt: iso(entry.changed_at)
    })),
    fulfillments: fulfillmentResult[0].map((entry) => ({
      id: bufferToUuid(entry.id), sellerOrderId: bufferToUuid(entry.seller_order_id),
      warehouseId: bufferToUuid(entry.warehouse_id), number: entry.fulfillment_number,
      status: entry.status, type: entry.fulfillment_type, warehouseName: entry.warehouse_name,
      sellerOrderNumber: entry.seller_order_number, merchantName: entry.merchant_name,
      itemCount: Number(entry.item_count), pickingStartedAt: iso(entry.picking_started_at),
      packedAt: iso(entry.packed_at), dispatchedAt: iso(entry.dispatched_at),
      completedAt: iso(entry.completed_at), notes: entry.notes,
      shipment: entry.shipment_id ? { id: bufferToUuid(entry.shipment_id),
        number: entry.shipment_number, providerCode: entry.provider_code,
        serviceCode: entry.service_code, trackingNumber: entry.tracking_number,
        status: entry.shipment_status, packageCount: Number(entry.package_count),
        packageWeight: number(entry.package_weight), shippedAt: iso(entry.shipped_at),
        deliveredAt: iso(entry.delivered_at) } : null
    }))
  };
}

export async function findOrderForUpdate({ tenantId, orderId, connection }) {
  const [rows] = await connection.execute(
    `SELECT id, status, version, payment_method, payment_status FROM customer_orders
      WHERE tenant_id = ? AND id = ? LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(orderId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), status: rows[0].status,
    paymentMethod: rows[0].payment_method, paymentStatus: rows[0].payment_status,
    version: Number(rows[0].version) } : null;
}

export async function findOrderByInternalNotes({ tenantId, notes, connection = getPrimaryPool() }) {
  const [rows] = await connection.execute(
    `SELECT id, status FROM customer_orders
      WHERE tenant_id = ? AND internal_notes = ?
      ORDER BY created_at DESC LIMIT 1`, [uuidToBuffer(tenantId), notes]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), status: rows[0].status } : null;
}

export async function updateOrderStatus({ tenantId, orderId, status, connection }) {
  const timestamp = status === "CANCELLED" ? ", cancelled_at = UTC_TIMESTAMP(6)"
    : status === "COMPLETED" ? ", completed_at = UTC_TIMESTAMP(6)" : "";
  await connection.execute(
    `UPDATE customer_orders SET status = ?, version = version + 1${timestamp}
      WHERE tenant_id = ? AND id = ?`, [status, uuidToBuffer(tenantId), uuidToBuffer(orderId)]
  );
  if (status === "CANCELLED" || status === "COMPLETED") {
    await connection.execute(
      `UPDATE seller_orders SET status = ?, version = version + 1,
        ${status === "CANCELLED" ? "cancelled_at" : "completed_at"} = UTC_TIMESTAMP(6)
        WHERE tenant_id = ? AND customer_order_id = ?`,
      [status, uuidToBuffer(tenantId), uuidToBuffer(orderId)]
    );
  }
}

export async function releaseDeliverySlot({ tenantId, orderId, connection }) {
  const [rows] = await connection.execute(
    `SELECT id, delivery_slot_instance_id, reserved_weight FROM delivery_slot_reservations
      WHERE tenant_id = ? AND customer_order_id = ? AND status = 'ACTIVE'
      LIMIT 1 FOR UPDATE`, [uuidToBuffer(tenantId), uuidToBuffer(orderId)]
  );
  if (!rows[0]) return;
  await connection.execute(
    `UPDATE delivery_slot_instances SET reserved_orders = GREATEST(reserved_orders - 1, 0),
       reserved_weight = GREATEST(reserved_weight - ?, 0), version = version + 1 WHERE id = ?`,
    [rows[0].reserved_weight, rows[0].delivery_slot_instance_id]
  );
  await connection.execute(
    `UPDATE delivery_slot_reservations SET status = 'RELEASED', released_at = UTC_TIMESTAMP(6)
      WHERE id = ?`, [rows[0].id]
  );
}

export async function hasDispatchedFulfillment({ tenantId, orderId, connection }) {
  const [rows] = await connection.execute(
    `SELECT EXISTS(SELECT 1 FROM fulfillments f JOIN seller_orders so ON so.id = f.seller_order_id
      WHERE f.tenant_id = ? AND so.customer_order_id = ?
        AND f.status IN ('DISPATCHED', 'COMPLETED')) AS found`,
    [uuidToBuffer(tenantId), uuidToBuffer(orderId)]
  );
  return Boolean(rows[0].found);
}

export async function releaseFulfillmentReservations({ tenantId, orderId, connection }) {
  const [rows] = await connection.execute(
    `SELECT sr.id, sr.inventory_balance_id, sr.inventory_lot_id, sr.quantity, f.id AS fulfillment_id
       FROM stock_reservations sr JOIN fulfillments f ON f.id = sr.reference_id
       JOIN seller_orders so ON so.id = f.seller_order_id
      WHERE sr.tenant_id = ? AND sr.reference_type = 'FULFILLMENT'
        AND so.customer_order_id = ? AND sr.status = 'ACTIVE' FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(orderId)]
  );
  for (const reservation of rows) {
    await connection.execute(
      `UPDATE inventory_balances SET reserved_quantity = GREATEST(reserved_quantity - ?, 0),
       version = version + 1 WHERE id = ?`,
      [reservation.quantity, reservation.inventory_balance_id]
    );
    if (reservation.inventory_lot_id) {
      await connection.execute(
        `UPDATE inventory_lots SET reserved_quantity = GREATEST(reserved_quantity - ?, 0),
         version = version + 1 WHERE id = ?`,
        [reservation.quantity, reservation.inventory_lot_id]
      );
    }
    await connection.execute(
      `UPDATE serial_numbers sn JOIN fulfillment_item_serials fis ON fis.serial_number_id = sn.id
       JOIN fulfillment_items fi ON fi.id = fis.fulfillment_item_id
       SET sn.status = 'AVAILABLE' WHERE fi.fulfillment_id = ? AND sn.status = 'RESERVED'`,
      [reservation.fulfillment_id]
    );
    await connection.execute(
      `UPDATE stock_reservations SET status = 'RELEASED', released_at = UTC_TIMESTAMP(6) WHERE id = ?`,
      [reservation.id]
    );
  }
  await connection.execute(
    `UPDATE fulfillments f JOIN seller_orders so ON so.id = f.seller_order_id
     SET f.status = 'CANCELLED' WHERE f.tenant_id = ? AND so.customer_order_id = ?
       AND f.status NOT IN ('DISPATCHED', 'COMPLETED')`,
    [uuidToBuffer(tenantId), uuidToBuffer(orderId)]
  );
  await connection.execute(
    `UPDATE order_items SET status = 'CANCELLED' WHERE tenant_id = ? AND customer_order_id = ?`,
    [uuidToBuffer(tenantId), uuidToBuffer(orderId)]
  );
  await connection.execute(
    `UPDATE seller_orders SET fulfillment_status = 'CANCELLED', version = version + 1
      WHERE tenant_id = ? AND customer_order_id = ?`,
    [uuidToBuffer(tenantId), uuidToBuffer(orderId)]
  );
}

export async function insertStatusHistory({ entry, connection }) {
  await connection.execute(
    `INSERT INTO order_status_history (id, tenant_id, customer_order_id, seller_order_id, status_type,
       previous_status, new_status, reason_code, notes, changed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(entry.id), uuidToBuffer(entry.tenantId), uuidToBuffer(entry.orderId),
      entry.sellerOrderId ? uuidToBuffer(entry.sellerOrderId) : null,
      entry.type || "ORDER", entry.previousStatus, entry.newStatus,
      entry.reasonCode || null, entry.notes || null,
      entry.actorUserId ? uuidToBuffer(entry.actorUserId) : null]
  );
}

export async function insertAudit({ audit, connection }) {
  await connection.execute(
    `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_type, action, entity_type,
       entity_id, request_id, ip_address, user_agent, before_data, after_data)
     VALUES (?, ?, ?, ?, ?, 'CUSTOMER_ORDER', ?, ?, INET6_ATON(?), ?, ?, ?)`,
    [uuidToBuffer(audit.id), uuidToBuffer(audit.tenantId), audit.actorUserId ? uuidToBuffer(audit.actorUserId) : null, audit.actorType || "USER",
      audit.action, uuidToBuffer(audit.orderId), audit.requestId, audit.ipAddress,
      audit.userAgent, JSON.stringify(audit.beforeData), JSON.stringify(audit.afterData)]
  );
}

export async function insertOutbox({ event, connection }) {
  await connection.execute(
    `INSERT INTO outbox_events (id, tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES (?, ?, 'CUSTOMER_ORDER', ?, ?, ?)`,
    [uuidToBuffer(event.id), uuidToBuffer(event.tenantId), uuidToBuffer(event.orderId),
      event.type, JSON.stringify(event.payload)]
  );
}

export async function getFulfillmentOptions({ tenantId, orderId, connection = getPrimaryPool() }) {
  const tenant = uuidToBuffer(tenantId);
  const order = uuidToBuffer(orderId);
  const stockLines = `WITH stock_lines AS (
    SELECT oi.id AS allocation_id, oi.id AS order_item_id, NULL AS bundle_component_id,
           oi.seller_order_id, oi.offer_id, oi.variant_id, oi.product_name,
           oi.variant_name, oi.sku, oi.quantity, oi.status, NULL AS bundle_product_name
      FROM order_items oi
     WHERE NOT EXISTS (SELECT 1 FROM order_item_bundle_components oibc
                        WHERE oibc.order_item_id = oi.id)
    UNION ALL
    SELECT oibc.id, oi.id, oibc.id, oi.seller_order_id, oibc.component_offer_id,
           oibc.component_variant_id, oibc.product_name, oibc.variant_name, oibc.sku,
           oibc.total_quantity, oi.status, oi.product_name
      FROM order_item_bundle_components oibc
      JOIN order_items oi ON oi.id = oibc.order_item_id
  )`;
  const [orderRows, sellerRows, itemRows, balanceRows, lotRows, serialRows] = await Promise.all([
    connection.execute(
      `SELECT id, status, fulfillment_status FROM customer_orders
        WHERE tenant_id = ? AND id = ? LIMIT 1`, [tenant, order]),
    connection.execute(
      `SELECT so.id, so.seller_order_number, so.merchant_id, so.status,
              so.fulfillment_status, m.display_name AS merchant_name,
              EXISTS(SELECT 1 FROM fulfillments f WHERE f.seller_order_id = so.id
                AND f.status <> 'CANCELLED') AS has_fulfillment
         FROM seller_orders so JOIN merchants m ON m.id = so.merchant_id
        WHERE so.tenant_id = ? AND so.customer_order_id = ? ORDER BY so.created_at`, [tenant, order]),
    connection.execute(
      `${stockLines}
       SELECT sl.allocation_id, sl.order_item_id, sl.bundle_component_id,
              sl.seller_order_id, sl.offer_id, sl.product_name, sl.variant_name,
              sl.sku, sl.quantity, sl.status, sl.bundle_product_name, pt.lot_tracking_enabled,
              pt.serial_tracking_enabled, pt.expiry_tracking_enabled,
              pv.warranty_months, pv.warranty_type
         FROM stock_lines sl JOIN product_variants pv ON pv.id = sl.variant_id
         JOIN products p ON p.id = pv.product_id JOIN product_types pt ON pt.id = p.product_type_id
         JOIN order_items oi ON oi.id = sl.order_item_id
        WHERE oi.tenant_id = ? AND oi.customer_order_id = ?
        ORDER BY oi.created_at, sl.bundle_component_id IS NOT NULL, sl.product_name`, [tenant, order]),
    connection.execute(
      `${stockLines}
       SELECT DISTINCT sl.allocation_id, sl.order_item_id, sl.bundle_component_id,
              w.id AS warehouse_id, w.code AS warehouse_code,
              w.name AS warehouse_name, w.merchant_id, a.city, ib.id AS balance_id,
              ib.on_hand_quantity, ib.reserved_quantity, ib.quarantine_quantity,
              (ib.on_hand_quantity - ib.reserved_quantity - ib.quarantine_quantity) AS available_quantity
         FROM stock_lines sl JOIN order_items oi ON oi.id = sl.order_item_id
         JOIN seller_orders so ON so.id = sl.seller_order_id
         JOIN customer_orders co ON co.id = oi.customer_order_id
         JOIN warehouses w ON w.tenant_id = oi.tenant_id AND w.merchant_id = so.merchant_id
          AND w.status = 'ACTIVE' AND w.deleted_at IS NULL
          AND (w.store_id IS NULL OR w.store_id = co.store_id)
         JOIN addresses a ON a.id = w.address_id
         LEFT JOIN inventory_balances ib ON ib.warehouse_id = w.id AND ib.offer_id = sl.offer_id
        WHERE oi.tenant_id = ? AND oi.customer_order_id = ?
        ORDER BY w.priority DESC, w.name`, [tenant, order]),
    connection.execute(
      `${stockLines}
       SELECT sl.allocation_id, sl.order_item_id, sl.bundle_component_id,
              w.id AS warehouse_id, il.id, il.lot_number,
              il.expires_at, il.on_hand_quantity, il.reserved_quantity, il.quarantine_quantity,
              (il.on_hand_quantity - il.reserved_quantity - il.quarantine_quantity) AS available_quantity
         FROM stock_lines sl JOIN order_items oi ON oi.id = sl.order_item_id
         JOIN seller_orders so ON so.id = sl.seller_order_id
         JOIN customer_orders co ON co.id = oi.customer_order_id
         JOIN warehouses w ON w.tenant_id = oi.tenant_id AND w.merchant_id = so.merchant_id
          AND w.status = 'ACTIVE' AND w.deleted_at IS NULL
          AND (w.store_id IS NULL OR w.store_id = co.store_id)
         JOIN inventory_balances ib ON ib.warehouse_id = w.id AND ib.offer_id = sl.offer_id
         JOIN inventory_lots il ON il.inventory_balance_id = ib.id AND il.status = 'ACTIVE'
        WHERE oi.tenant_id = ? AND oi.customer_order_id = ?
          AND il.on_hand_quantity > il.reserved_quantity + il.quarantine_quantity
        ORDER BY il.expires_at IS NULL, il.expires_at, il.received_at`, [tenant, order]),
    connection.execute(
      `${stockLines}
       SELECT sl.allocation_id, sl.order_item_id, sl.bundle_component_id,
              w.id AS warehouse_id, sn.id, sn.serial_number
         FROM stock_lines sl JOIN order_items oi ON oi.id = sl.order_item_id
         JOIN seller_orders so ON so.id = sl.seller_order_id
         JOIN customer_orders co ON co.id = oi.customer_order_id
         JOIN warehouses w ON w.tenant_id = oi.tenant_id AND w.merchant_id = so.merchant_id
          AND w.status = 'ACTIVE' AND w.deleted_at IS NULL
          AND (w.store_id IS NULL OR w.store_id = co.store_id)
         JOIN inventory_balances ib ON ib.warehouse_id = w.id AND ib.offer_id = sl.offer_id
         JOIN serial_numbers sn ON sn.inventory_balance_id = ib.id AND sn.status = 'AVAILABLE'
        WHERE oi.tenant_id = ? AND oi.customer_order_id = ?
        ORDER BY sn.received_at, sn.serial_number`, [tenant, order])
  ]);
  if (!orderRows[0][0]) return null;
  const items = itemRows[0].map((row) => ({
    id: bufferToUuid(row.allocation_id), allocationId: bufferToUuid(row.allocation_id),
    orderItemId: bufferToUuid(row.order_item_id),
    bundleComponentId: row.bundle_component_id ? bufferToUuid(row.bundle_component_id) : null,
    bundleProductName: row.bundle_product_name || null,
    sellerOrderId: bufferToUuid(row.seller_order_id),
    offerId: bufferToUuid(row.offer_id), productName: row.product_name,
    variantName: row.variant_name, sku: row.sku, quantity: number(row.quantity),
    status: row.status, lotTracking: Boolean(row.lot_tracking_enabled),
    serialTracking: Boolean(row.serial_tracking_enabled),
    expiryTracking: Boolean(row.expiry_tracking_enabled),
    warrantyMonths: row.warranty_months === null ? null : Number(row.warranty_months),
    warrantyType: row.warranty_type
  }));
  const lots = lotRows[0].map((row) => ({ allocationId: bufferToUuid(row.allocation_id),
    orderItemId: bufferToUuid(row.order_item_id),
    warehouseId: bufferToUuid(row.warehouse_id), id: bufferToUuid(row.id),
    lotNumber: row.lot_number, expiresAt: row.expires_at ? iso(row.expires_at).slice(0, 10) : null,
    availableQuantity: number(row.available_quantity) }));
  const serials = serialRows[0].map((row) => ({ allocationId: bufferToUuid(row.allocation_id),
    orderItemId: bufferToUuid(row.order_item_id),
    warehouseId: bufferToUuid(row.warehouse_id), id: bufferToUuid(row.id), number: row.serial_number }));
  return {
    order: { id: orderId, status: orderRows[0][0].status,
      fulfillmentStatus: orderRows[0][0].fulfillment_status },
    sellerOrders: sellerRows[0].map((row) => ({ id: bufferToUuid(row.id),
      number: row.seller_order_number, merchantId: bufferToUuid(row.merchant_id),
      merchantName: row.merchant_name, status: row.status,
      fulfillmentStatus: row.fulfillment_status, hasFulfillment: Boolean(row.has_fulfillment),
      items: items.filter((item) => item.sellerOrderId === bufferToUuid(row.id)) })),
    warehouses: [...new Map(balanceRows[0].map((row) => [bufferToUuid(row.warehouse_id), {
      id: bufferToUuid(row.warehouse_id), code: row.warehouse_code, name: row.warehouse_name,
      merchantId: bufferToUuid(row.merchant_id), city: row.city
    }])).values()],
    inventory: balanceRows[0].map((row) => ({
      allocationId: bufferToUuid(row.allocation_id), orderItemId: bufferToUuid(row.order_item_id),
      bundleComponentId: row.bundle_component_id ? bufferToUuid(row.bundle_component_id) : null,
      warehouseId: bufferToUuid(row.warehouse_id),
      balanceId: row.balance_id ? bufferToUuid(row.balance_id) : null,
      onHandQuantity: number(row.on_hand_quantity) || 0,
      reservedQuantity: number(row.reserved_quantity) || 0,
      availableQuantity: number(row.available_quantity) || 0,
      lots: lots.filter((lot) => lot.allocationId === bufferToUuid(row.allocation_id)
        && lot.warehouseId === bufferToUuid(row.warehouse_id)),
      serials: serials.filter((serial) => serial.allocationId === bufferToUuid(row.allocation_id)
        && serial.warehouseId === bufferToUuid(row.warehouse_id))
    }))
  };
}

export async function findSellerOrderForFulfillment({ tenantId, orderId, sellerOrderId, connection }) {
  const [sellerRows] = await connection.execute(
    `SELECT so.id, so.merchant_id, so.status, so.fulfillment_status,
            co.status AS order_status, co.payment_method, co.payment_status, co.store_id, co.customer_id,
            EXISTS(SELECT 1 FROM fulfillments f WHERE f.seller_order_id = so.id
              AND f.status <> 'CANCELLED') AS has_fulfillment
       FROM seller_orders so JOIN customer_orders co ON co.id = so.customer_order_id
      WHERE so.tenant_id = ? AND so.id = ? AND co.id = ? LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(sellerOrderId), uuidToBuffer(orderId)]
  );
  if (!sellerRows[0]) return null;
  const [itemRows] = await connection.execute(
    `SELECT oi.id, oi.offer_id, oi.variant_id, oi.product_name, oi.quantity, oi.status,
            pt.lot_tracking_enabled, pt.serial_tracking_enabled, pt.expiry_tracking_enabled,
            pv.warranty_months, pv.warranty_type
       FROM order_items oi JOIN product_variants pv ON pv.id = oi.variant_id
       JOIN products p ON p.id = pv.product_id JOIN product_types pt ON pt.id = p.product_type_id
      WHERE oi.tenant_id = ? AND oi.seller_order_id = ?
        AND NOT EXISTS (SELECT 1 FROM order_item_bundle_components oibc WHERE oibc.order_item_id = oi.id)
      ORDER BY oi.created_at FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(sellerOrderId)]
  );
  const [componentRows] = await connection.execute(
    `SELECT oi.id AS order_item_id, oibc.id AS bundle_component_id,
            oibc.component_offer_id AS offer_id, oibc.component_variant_id AS variant_id,
            oibc.product_name, oibc.total_quantity AS quantity, oi.status,
            pt.lot_tracking_enabled, pt.serial_tracking_enabled, pt.expiry_tracking_enabled,
            pv.warranty_months, pv.warranty_type, oi.product_name AS bundle_product_name
       FROM order_item_bundle_components oibc
       JOIN order_items oi ON oi.id = oibc.order_item_id
       JOIN product_variants pv ON pv.id = oibc.component_variant_id
       JOIN products p ON p.id = pv.product_id JOIN product_types pt ON pt.id = p.product_type_id
      WHERE oibc.tenant_id = ? AND oi.seller_order_id = ?
      ORDER BY oi.created_at, oibc.sort_order FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(sellerOrderId)]
  );
  const row = sellerRows[0];
  return { id: bufferToUuid(row.id), merchantId: bufferToUuid(row.merchant_id),
    status: row.status, fulfillmentStatus: row.fulfillment_status, orderStatus: row.order_status,
    paymentMethod: row.payment_method, paymentStatus: row.payment_status,
    hasFulfillment: Boolean(row.has_fulfillment),
    storeId: bufferToUuid(row.store_id), customerId: row.customer_id ? bufferToUuid(row.customer_id) : null,
    items: [...itemRows.map((item) => ({ id: bufferToUuid(item.id), allocationId: bufferToUuid(item.id),
      orderItemId: bufferToUuid(item.id), bundleComponentId: null,
      offerId: bufferToUuid(item.offer_id),
      variantId: bufferToUuid(item.variant_id), productName: item.product_name,
      quantity: number(item.quantity), status: item.status,
      lotTracking: Boolean(item.lot_tracking_enabled), serialTracking: Boolean(item.serial_tracking_enabled),
      expiryTracking: Boolean(item.expiry_tracking_enabled),
      warrantyMonths: item.warranty_months === null ? null : Number(item.warranty_months),
      warrantyType: item.warranty_type })), ...componentRows.map((item) => ({
      id: bufferToUuid(item.bundle_component_id), allocationId: bufferToUuid(item.bundle_component_id),
      orderItemId: bufferToUuid(item.order_item_id),
      bundleComponentId: bufferToUuid(item.bundle_component_id),
      offerId: bufferToUuid(item.offer_id), variantId: bufferToUuid(item.variant_id),
      productName: item.product_name, bundleProductName: item.bundle_product_name,
      quantity: number(item.quantity), status: item.status,
      lotTracking: Boolean(item.lot_tracking_enabled), serialTracking: Boolean(item.serial_tracking_enabled),
      expiryTracking: Boolean(item.expiry_tracking_enabled),
      warrantyMonths: item.warranty_months === null ? null : Number(item.warranty_months),
      warrantyType: item.warranty_type }))] };
}

export async function findWarehouseForFulfillment({ tenantId, warehouseId, merchantId, storeId, connection }) {
  const [rows] = await connection.execute(
    `SELECT id, name FROM warehouses WHERE tenant_id = ? AND id = ? AND merchant_id = ?
      AND status = 'ACTIVE' AND deleted_at IS NULL AND (store_id IS NULL OR store_id = ?) LIMIT 1`,
    [uuidToBuffer(tenantId), uuidToBuffer(warehouseId), uuidToBuffer(merchantId), uuidToBuffer(storeId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), name: rows[0].name } : null;
}

export async function findBalanceForFulfillment({ tenantId, warehouseId, offerId, connection }) {
  const [rows] = await connection.execute(
    `SELECT id, on_hand_quantity, reserved_quantity, quarantine_quantity
       FROM inventory_balances WHERE tenant_id = ? AND warehouse_id = ? AND offer_id = ?
       LIMIT 1 FOR UPDATE`, [uuidToBuffer(tenantId), uuidToBuffer(warehouseId), uuidToBuffer(offerId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), onHandQuantity: number(rows[0].on_hand_quantity),
    reservedQuantity: number(rows[0].reserved_quantity), quarantineQuantity: number(rows[0].quarantine_quantity) } : null;
}

export async function listLotsForFulfillment({ tenantId, balanceId, connection }) {
  const [rows] = await connection.execute(
    `SELECT id, lot_number, expires_at, on_hand_quantity, reserved_quantity, quarantine_quantity
       FROM inventory_lots WHERE tenant_id = ? AND inventory_balance_id = ? AND status = 'ACTIVE'
       ORDER BY expires_at IS NULL, expires_at, received_at FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(balanceId)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), lotNumber: row.lot_number,
    expiresAt: row.expires_at ? iso(row.expires_at).slice(0, 10) : null,
    onHandQuantity: number(row.on_hand_quantity), reservedQuantity: number(row.reserved_quantity),
    quarantineQuantity: number(row.quarantine_quantity) }));
}

export async function listSerialsForFulfillment({ tenantId, balanceId, serialIds, connection }) {
  if (!serialIds.length) return [];
  const placeholders = serialIds.map(() => "?").join(", ");
  const [rows] = await connection.execute(
    `SELECT id, serial_number FROM serial_numbers WHERE tenant_id = ? AND inventory_balance_id = ?
      AND status = 'AVAILABLE' AND id IN (${placeholders}) FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(balanceId), ...serialIds.map(uuidToBuffer)]
  );
  return rows.map((row) => ({ id: bufferToUuid(row.id), number: row.serial_number }));
}

export async function insertFulfillment({ fulfillment, connection }) {
  await connection.execute(
    `INSERT INTO fulfillments (id, tenant_id, seller_order_id, warehouse_id,
       fulfillment_number, status, fulfillment_type, assigned_to, notes)
     VALUES (?, ?, ?, ?, ?, 'PENDING', 'SHIPMENT', ?, ?)`,
    [uuidToBuffer(fulfillment.id), uuidToBuffer(fulfillment.tenantId),
      uuidToBuffer(fulfillment.sellerOrderId), uuidToBuffer(fulfillment.warehouseId),
      fulfillment.number, uuidToBuffer(fulfillment.actorUserId), fulfillment.notes || null]
  );
}

export async function insertFulfillmentItem({ item, connection }) {
  await connection.execute(
    `INSERT INTO fulfillment_items (id, fulfillment_id, order_item_id, bundle_component_id, inventory_lot_id,
       requested_quantity, picked_quantity, packed_quantity, actual_weight)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    [uuidToBuffer(item.id), uuidToBuffer(item.fulfillmentId), uuidToBuffer(item.orderItemId),
      item.bundleComponentId ? uuidToBuffer(item.bundleComponentId) : null,
      item.lotId ? uuidToBuffer(item.lotId) : null, item.quantity, item.actualWeight || null]
  );
}

export async function reserveFulfillmentStock({ reservation, connection }) {
  await connection.execute(
    `UPDATE inventory_balances SET reserved_quantity = reserved_quantity + ?, version = version + 1,
       last_movement_at = UTC_TIMESTAMP(6) WHERE id = ?`,
    [reservation.quantity, uuidToBuffer(reservation.balanceId)]
  );
  if (reservation.lotId) {
    await connection.execute(
      `UPDATE inventory_lots SET reserved_quantity = reserved_quantity + ?, version = version + 1 WHERE id = ?`,
      [reservation.quantity, uuidToBuffer(reservation.lotId)]
    );
  }
  await connection.execute(
    `INSERT INTO stock_reservations (id, tenant_id, inventory_balance_id, inventory_lot_id,
       reference_type, reference_id, quantity, status)
     VALUES (?, ?, ?, ?, 'FULFILLMENT', ?, ?, 'ACTIVE')`,
    [uuidToBuffer(reservation.id), uuidToBuffer(reservation.tenantId),
      uuidToBuffer(reservation.balanceId), reservation.lotId ? uuidToBuffer(reservation.lotId) : null,
      uuidToBuffer(reservation.fulfillmentId), reservation.quantity]
  );
}

export async function reserveFulfillmentSerial({ fulfillmentItemId, serialId, connection }) {
  await connection.execute("UPDATE serial_numbers SET status = 'RESERVED' WHERE id = ?",
    [uuidToBuffer(serialId)]);
  await connection.execute(
    `INSERT INTO fulfillment_item_serials (fulfillment_item_id, serial_number_id) VALUES (?, ?)`,
    [uuidToBuffer(fulfillmentItemId), uuidToBuffer(serialId)]
  );
}

export async function markFulfillmentAllocated({ tenantId, orderId, sellerOrderId, connection }) {
  await connection.execute(
    `UPDATE seller_orders SET status = 'PROCESSING', fulfillment_status = 'PROCESSING',
       version = version + 1 WHERE tenant_id = ? AND id = ?`,
    [uuidToBuffer(tenantId), uuidToBuffer(sellerOrderId)]
  );
  await connection.execute(
    `UPDATE customer_orders SET status = CASE WHEN status = 'CONFIRMED' THEN 'PROCESSING' ELSE status END,
       fulfillment_status = 'PROCESSING', version = version + 1 WHERE tenant_id = ? AND id = ?`,
    [uuidToBuffer(tenantId), uuidToBuffer(orderId)]
  );
}

export async function findFulfillmentForUpdate({ tenantId, orderId, fulfillmentId, connection }) {
  const [rows] = await connection.execute(
    `SELECT f.id, f.status, f.seller_order_id, f.warehouse_id, so.customer_order_id,
            so.merchant_id,
            co.customer_id, co.fulfillment_status, sh.id AS shipment_id
       FROM fulfillments f JOIN seller_orders so ON so.id = f.seller_order_id
       JOIN customer_orders co ON co.id = so.customer_order_id
       LEFT JOIN shipments sh ON sh.fulfillment_id = f.id
      WHERE f.tenant_id = ? AND f.id = ? AND co.id = ? LIMIT 1 FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(fulfillmentId), uuidToBuffer(orderId)]
  );
  return rows[0] ? { id: bufferToUuid(rows[0].id), status: rows[0].status,
    sellerOrderId: bufferToUuid(rows[0].seller_order_id), merchantId: bufferToUuid(rows[0].merchant_id),
    warehouseId: bufferToUuid(rows[0].warehouse_id),
    orderId: bufferToUuid(rows[0].customer_order_id),
    customerId: rows[0].customer_id ? bufferToUuid(rows[0].customer_id) : null,
    shipmentId: rows[0].shipment_id ? bufferToUuid(rows[0].shipment_id) : null,
    orderFulfillmentStatus: rows[0].fulfillment_status } : null;
}

export async function listFulfillmentStock({ tenantId, fulfillmentId, connection }) {
  const [rows] = await connection.execute(
    `SELECT fi.id AS fulfillment_item_id, fi.order_item_id, fi.bundle_component_id,
            fi.inventory_lot_id, fi.requested_quantity,
            COALESCE(oibc.component_offer_id, oi.offer_id) AS offer_id,
            COALESCE(oibc.component_variant_id, oi.variant_id) AS variant_id,
            pv.warranty_months,
            pv.warranty_type, ib.id AS balance_id, sr.id AS reservation_id
       FROM fulfillment_items fi JOIN order_items oi ON oi.id = fi.order_item_id
       LEFT JOIN order_item_bundle_components oibc ON oibc.id = fi.bundle_component_id
       JOIN product_variants pv ON pv.id = COALESCE(oibc.component_variant_id, oi.variant_id)
       JOIN fulfillments f ON f.id = fi.fulfillment_id
       JOIN inventory_balances ib ON ib.warehouse_id = f.warehouse_id
        AND ib.offer_id = COALESCE(oibc.component_offer_id, oi.offer_id)
       JOIN stock_reservations sr ON sr.reference_type = 'FULFILLMENT'
        AND sr.reference_id = f.id AND sr.inventory_balance_id = ib.id
        AND (sr.inventory_lot_id <=> fi.inventory_lot_id) AND sr.status = 'ACTIVE'
      WHERE f.tenant_id = ? AND f.id = ? FOR UPDATE`,
    [uuidToBuffer(tenantId), uuidToBuffer(fulfillmentId)]
  );
  return rows.map((row) => ({ fulfillmentItemId: bufferToUuid(row.fulfillment_item_id),
    orderItemId: bufferToUuid(row.order_item_id), lotId: row.inventory_lot_id ? bufferToUuid(row.inventory_lot_id) : null,
    bundleComponentId: row.bundle_component_id ? bufferToUuid(row.bundle_component_id) : null,
    quantity: number(row.requested_quantity), balanceId: bufferToUuid(row.balance_id),
    reservationId: bufferToUuid(row.reservation_id), warrantyMonths: row.warranty_months === null ? null : Number(row.warranty_months),
    warrantyType: row.warranty_type }));
}

export async function listFulfillmentSerials({ fulfillmentId, connection }) {
  const [rows] = await connection.execute(
    `SELECT fis.fulfillment_item_id, sn.id, sn.serial_number FROM fulfillment_item_serials fis
       JOIN serial_numbers sn ON sn.id = fis.serial_number_id
      WHERE fis.fulfillment_item_id IN (SELECT id FROM fulfillment_items WHERE fulfillment_id = ?)
      FOR UPDATE`, [uuidToBuffer(fulfillmentId)]
  );
  return rows.map((row) => ({ fulfillmentItemId: bufferToUuid(row.fulfillment_item_id),
    id: bufferToUuid(row.id), number: row.serial_number }));
}

export async function updateFulfillmentStage({ tenantId, fulfillmentId, status, connection }) {
  const timestamp = { PICKING: "picking_started_at", PACKED: "packed_at",
    DISPATCHED: "dispatched_at", COMPLETED: "completed_at" }[status];
  await connection.execute(
    `UPDATE fulfillments SET status = ?, ${timestamp} = UTC_TIMESTAMP(6) WHERE tenant_id = ? AND id = ?`,
    [status, uuidToBuffer(tenantId), uuidToBuffer(fulfillmentId)]
  );
  if (status === "PICKING") {
    await connection.execute(
      `UPDATE fulfillment_items SET picked_quantity = requested_quantity WHERE fulfillment_id = ?`,
      [uuidToBuffer(fulfillmentId)]
    );
  }
  if (status === "PACKED") {
    await connection.execute(
      `UPDATE fulfillment_items SET packed_quantity = requested_quantity WHERE fulfillment_id = ?`,
      [uuidToBuffer(fulfillmentId)]
    );
  }
}

export async function updateFulfillmentOrderItems({ fulfillmentId, status, connection }) {
  await connection.execute(
    `UPDATE order_items oi JOIN fulfillment_items fi ON fi.order_item_id = oi.id
       SET oi.status = ? WHERE fi.fulfillment_id = ?`,
    [status, uuidToBuffer(fulfillmentId)]
  );
}

export async function consumeFulfillmentStock({ stock, tenantId, fulfillmentId, actorUserId, connection }) {
  await connection.execute(
    `UPDATE inventory_balances SET on_hand_quantity = on_hand_quantity - ?,
       reserved_quantity = reserved_quantity - ?, version = version + 1,
       last_movement_at = UTC_TIMESTAMP(6) WHERE id = ?`,
    [stock.quantity, stock.quantity, uuidToBuffer(stock.balanceId)]
  );
  if (stock.lotId) {
    await connection.execute(
      `UPDATE inventory_lots SET on_hand_quantity = on_hand_quantity - ?,
       reserved_quantity = reserved_quantity - ?, version = version + 1 WHERE id = ?`,
      [stock.quantity, stock.quantity, uuidToBuffer(stock.lotId)]
    );
  }
  await connection.execute(
    `UPDATE stock_reservations SET status = 'CONSUMED', released_at = UTC_TIMESTAMP(6) WHERE id = ?`,
    [uuidToBuffer(stock.reservationId)]
  );
  await connection.execute(
    `INSERT INTO stock_ledger_entries (id, tenant_id, inventory_balance_id, inventory_lot_id,
       movement_type, quantity_delta, reserved_delta, reference_type, reference_id, reason_code, created_by)
     VALUES (?, ?, ?, ?, 'ORDER_DISPATCH', ?, ?, 'FULFILLMENT', ?, 'CUSTOMER_ORDER', ?)`,
    [uuidToBuffer(stock.ledgerId), uuidToBuffer(tenantId), uuidToBuffer(stock.balanceId),
      stock.lotId ? uuidToBuffer(stock.lotId) : null, -stock.quantity, -stock.quantity,
      uuidToBuffer(fulfillmentId), uuidToBuffer(actorUserId)]
  );
}

export async function markSerialSold({ serial, connection }) {
  await connection.execute(
    `UPDATE serial_numbers SET status = 'SOLD', sold_at = UTC_TIMESTAMP(6),
       warranty_starts_at = CASE WHEN ? IS NULL THEN NULL ELSE UTC_DATE() END,
       warranty_ends_at = CASE WHEN ? IS NULL THEN NULL ELSE DATE_ADD(UTC_DATE(), INTERVAL ? MONTH) END
      WHERE id = ?`,
    [serial.warrantyMonths, serial.warrantyMonths, serial.warrantyMonths || 0, uuidToBuffer(serial.id)]
  );
}

export async function insertWarrantyRegistration({ warranty, connection }) {
  await connection.execute(
    `INSERT INTO warranty_registrations (id, tenant_id, order_item_id, serial_number_id,
       customer_id, warranty_type, starts_at, ends_at, status, terms_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, UTC_DATE(), DATE_ADD(UTC_DATE(), INTERVAL ? MONTH), 'ACTIVE', ?)`,
    [uuidToBuffer(warranty.id), uuidToBuffer(warranty.tenantId), uuidToBuffer(warranty.orderItemId),
      uuidToBuffer(warranty.serialId), warranty.customerId ? uuidToBuffer(warranty.customerId) : null,
      warranty.type, warranty.months, JSON.stringify({ months: warranty.months, type: warranty.type })]
  );
}

export async function insertShipment({ shipment, connection }) {
  await connection.execute(
    `INSERT INTO shipments (id, tenant_id, fulfillment_id, shipment_number, provider_code,
       service_code, tracking_number, status, package_count, package_weight, shipping_charge,
       shipped_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'SHIPPED', ?, ?, 0, UTC_TIMESTAMP(6), ?)`,
    [uuidToBuffer(shipment.id), uuidToBuffer(shipment.tenantId), uuidToBuffer(shipment.fulfillmentId),
      shipment.number, shipment.providerCode, shipment.serviceCode || null, shipment.trackingNumber,
      shipment.packageCount, shipment.packageWeight || null, JSON.stringify({ manual: true })]
  );
}

export async function insertTrackingEvent({ event, connection }) {
  await connection.execute(
    `INSERT INTO shipment_tracking_events (id, tenant_id, shipment_id, event_code,
       status, description, location, occurred_at, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), ?)`,
    [uuidToBuffer(event.id), uuidToBuffer(event.tenantId), uuidToBuffer(event.shipmentId),
      event.code, event.status, event.description || null, event.location || null,
      JSON.stringify({ manual: true })]
  );
}

export async function markFulfillmentDispatched({ tenantId, orderId, sellerOrderId, connection }) {
  await connection.execute(
    `UPDATE seller_orders SET status = 'PROCESSING', fulfillment_status = 'PROCESSING',
       version = version + 1 WHERE tenant_id = ? AND id = ?`,
    [uuidToBuffer(tenantId), uuidToBuffer(sellerOrderId)]
  );
  await connection.execute(
    `UPDATE customer_orders SET fulfillment_status = 'PROCESSING', version = version + 1
      WHERE tenant_id = ? AND id = ?`, [uuidToBuffer(tenantId), uuidToBuffer(orderId)]
  );
}

export async function markFulfillmentCompleted({ tenantId, orderId, sellerOrderId, fulfillmentId, connection }) {
  await connection.execute(
    `UPDATE shipments SET status = 'DELIVERED', delivered_at = UTC_TIMESTAMP(6)
      WHERE tenant_id = ? AND fulfillment_id = ?`,
    [uuidToBuffer(tenantId), uuidToBuffer(fulfillmentId)]
  );
  await connection.execute(
    `UPDATE seller_orders SET status = 'COMPLETED', fulfillment_status = 'FULFILLED',
       completed_at = UTC_TIMESTAMP(6), version = version + 1 WHERE tenant_id = ? AND id = ?`,
    [uuidToBuffer(tenantId), uuidToBuffer(sellerOrderId)]
  );
  const [remaining] = await connection.execute(
    `SELECT COUNT(*) AS total FROM seller_orders WHERE tenant_id = ? AND customer_order_id = ?
      AND fulfillment_status <> 'FULFILLED'`, [uuidToBuffer(tenantId), uuidToBuffer(orderId)]
  );
  const status = Number(remaining[0].total) === 0 ? "FULFILLED" : "PARTIALLY_FULFILLED";
  await connection.execute(
    `UPDATE customer_orders SET fulfillment_status = ?, version = version + 1
      WHERE tenant_id = ? AND id = ?`, [status, uuidToBuffer(tenantId), uuidToBuffer(orderId)]
  );
  return status;
}
