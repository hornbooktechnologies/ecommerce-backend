import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { isIntraStateSupply, normalizeGstStateCode } from "../../core/india/gst.js";
import { withTransaction } from "../../database/transaction.js";
import Decimal from "decimal.js";
import * as defaultDao from "./orders.dao.js";
import * as defaultFinanceService from "../marketplace-finance/marketplace-finance.service.js";

const transitions = {
  DRAFT: ["PLACED", "CANCELLED"],
  PLACED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: []
};

const fulfillmentTransitions = {
  PENDING: ["PICKING"],
  PICKING: ["PACKED"],
  PACKED: ["DISPATCHED"],
  DISPATCHED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: []
};

function documentNumber(prefix, id) {
  return `${prefix}-${id.replaceAll("-", "").slice(-12).toUpperCase()}`;
}

function fail(code, message, status = 422, field = null) {
  throw new AppError({ code, message, status,
    details: field ? [{ field, code: code.toLowerCase(), message }] : [] });
}

function calculateIncludedTax(offer, quantity, grossAmount) {
  const intraState = isIntraStateSupply(offer.registrationStateCode, offer.destinationStateCode);
  const cgstRate = intraState ? new Decimal(offer.cgstRate || 0) : new Decimal(0);
  const sgstRate = intraState ? new Decimal(offer.sgstRate || 0) : new Decimal(0);
  const igstRate = intraState ? new Decimal(0) : new Decimal(offer.igstRate || 0);
  const cessRate = new Decimal(offer.cessRate || 0);
  const fixedCess = new Decimal(offer.cessAmount || 0).times(quantity);
  const percentageRate = cgstRate.plus(sgstRate).plus(igstRate).plus(cessRate);
  const percentageBase = Decimal.max(new Decimal(0), grossAmount.minus(fixedCess))
    .div(new Decimal(1).plus(percentageRate.div(100)));
  const cgstAmount = percentageBase.times(cgstRate).div(100).toDecimalPlaces(4);
  const sgstAmount = percentageBase.times(sgstRate).div(100).toDecimalPlaces(4);
  const igstAmount = percentageBase.times(igstRate).div(100).toDecimalPlaces(4);
  const cessAmount = percentageBase.times(cessRate).div(100).plus(fixedCess).toDecimalPlaces(4);
  const taxTotal = cgstAmount.plus(sgstAmount).plus(igstAmount).plus(cessAmount);
  return { intraState, cgstRate, sgstRate, igstRate, cessRate, cgstAmount, sgstAmount,
    igstAmount, cessAmount, taxTotal, taxableAmount: grossAmount.minus(taxTotal) };
}

export function createOrdersService({ dao = defaultDao, transaction = withTransaction,
  financeService = defaultFinanceService } = {}) {
  async function resolveBundleComponents({ tenantId, bundleVariantId, merchantId, storeId,
    connection, path = [], multiplier = new Decimal(1) }) {
    if (path.includes(bundleVariantId)) {
      fail("BUNDLE_COMPONENT_CYCLE", "The bundle contains a circular component relationship.", 409);
    }
    const rows = await dao.listRequiredBundleComponents({ tenantId, bundleVariantId,
      merchantId, storeId, connection });
    if (!rows.length) {
      fail("BUNDLE_COMPONENTS_REQUIRED", "This bundle has no required components and cannot be ordered.", 409);
    }
    const resolved = [];
    for (const row of rows) {
      const quantity = multiplier.times(row.quantity);
      if (row.productKind === "BUNDLE") {
        resolved.push(...await resolveBundleComponents({ tenantId,
          bundleVariantId: row.componentVariantId, merchantId, storeId, connection,
          path: [...path, bundleVariantId], multiplier: quantity }));
        continue;
      }
      if (!row.offerId) {
        fail("BUNDLE_COMPONENT_OFFER_MISSING",
          `${row.productName} needs an active offer from the same seller and store.`, 409);
      }
      resolved.push({ ...row, quantityPerBundle: quantity });
    }
    const aggregated = new Map();
    for (const component of resolved) {
      const current = aggregated.get(component.offerId);
      if (current) current.quantityPerBundle = current.quantityPerBundle.plus(component.quantityPerBundle);
      else aggregated.set(component.offerId, { ...component,
        quantityPerBundle: new Decimal(component.quantityPerBundle) });
    }
    return [...aggregated.values()];
  }

  async function listCreationOptions(tenantId) {
    const options = await dao.listCreationOptions({ tenantId });
    if (!dao.listRequiredBundleComponents) return options;
    for (const offer of options.offers.filter((entry) => entry.productKind === "BUNDLE")) {
      try {
        const components = await resolveBundleComponents({ tenantId,
          bundleVariantId: offer.variantId, merchantId: offer.merchantId, storeId: offer.storeId });
        offer.availableQuantity = components.reduce((available, component) => Math.min(available,
          Math.floor(new Decimal(component.availableQuantity)
            .div(component.quantityPerBundle).toNumber())), Number.MAX_SAFE_INTEGER);
        offer.bundleComponents = components.map((component) => ({ offerId: component.offerId,
          productName: component.productName, variantName: component.variantName, sku: component.sku,
          quantityPerBundle: component.quantityPerBundle.toNumber(),
          availableQuantity: component.availableQuantity }));
      } catch (error) {
        offer.availableQuantity = 0;
        offer.bundleIssue = error.message || "Bundle components are not ready for sale.";
      }
    }
    return options;
  }

  async function listOrders(tenantId, filters) {
    return dao.listOrders({ tenantId, filters });
  }

  async function createOrder(tenantId, input, context) {
    return transaction(tenantId, async (connection) => {
      const store = await dao.findStoreContext({ tenantId, storeId: input.storeId, connection });
      if (!store) fail("STORE_NOT_FOUND", "Select an active store.", 404, "storeId");
      const destinationStateCode = normalizeGstStateCode(input.shippingAddress.stateCode);
      if (!destinationStateCode) {
        fail("ORDER_DESTINATION_STATE_INVALID", "Select a valid Indian shipping state.", 422, "shippingAddress.stateCode");
      }
      const offerIds = input.items.map((item) => item.offerId);
      const offers = await dao.findOffersForOrder({ tenantId, storeId: store.id, offerIds,
        destinationStateCode, connection });
      if (offers.length !== offerIds.length) {
        fail("ORDER_OFFER_UNAVAILABLE", "One or more selected products are no longer available for this store.", 409, "items");
      }
      const offerMap = new Map(offers.map((offer) => [offer.id, offer]));
      const lines = input.items.map((selected, index) => {
        const offer = offerMap.get(selected.offerId);
        if (!offer.hsnSacCode || !offer.taxCategoryId) {
          fail("ORDER_TAX_CLASSIFICATION_MISSING", `${offer.productName} needs an active HSN/SAC tax category.`, 422, `items.${index}.offerId`);
        }
        if (!offer.taxRateId) {
          fail("ORDER_TAX_RATE_MISSING", `${offer.productName} does not have an effective GST rate for this destination.`, 422, `items.${index}.offerId`);
        }
        if (!offer.registrationGstin || !normalizeGstStateCode(offer.registrationStateCode)) {
          fail("ORDER_SELLER_GST_REGISTRATION_MISSING", `${offer.merchantName || "The seller"} needs an active GST registration before this order can be placed.`, 422, `items.${index}.offerId`);
        }
        const quantity = new Decimal(selected.quantity);
        const minimum = new Decimal(offer.minimumOrderQuantity);
        const step = new Decimal(offer.quantityStep);
        if (quantity.lessThan(minimum)) {
          fail("ORDER_QUANTITY_BELOW_MINIMUM", `${offer.productName} requires at least ${minimum.toString()}.`, 422, `items.${index}.quantity`);
        }
        if (offer.maximumOrderQuantity !== null && quantity.greaterThan(offer.maximumOrderQuantity)) {
          fail("ORDER_QUANTITY_ABOVE_MAXIMUM", `${offer.productName} allows at most ${offer.maximumOrderQuantity}.`, 422, `items.${index}.quantity`);
        }
        if (!quantity.minus(minimum).modulo(step).isZero()) {
          fail("ORDER_QUANTITY_STEP_INVALID", `${offer.productName} must change in steps of ${step.toString()}.`, 422, `items.${index}.quantity`);
        }
        const listTotal = new Decimal(offer.listPrice).times(quantity);
        const lineTotal = new Decimal(offer.salePrice).times(quantity);
        const tax = calculateIncludedTax({ ...offer, destinationStateCode }, quantity, lineTotal);
        const estimatedWeight = offer.soldByWeight ? quantity
          : offer.estimatedWeight === null ? new Decimal(0) : new Decimal(offer.estimatedWeight).times(quantity);
        return { ...offer, ...tax, destinationStateCode, itemId: createId(), offerId: offer.id, quantity: quantity.toString(),
          substitutionPreference: offer.vertical === "GROCERY" ? selected.substitutionPreference : null,
          listTotal, lineTotal, discountTotal: listTotal.minus(lineTotal), estimatedWeight };
      });
      for (const line of lines.filter((entry) => entry.productKind === "BUNDLE")) {
        const components = await resolveBundleComponents({ tenantId, bundleVariantId: line.variantId,
          merchantId: line.merchantId, storeId: store.id, connection });
        const available = components.reduce((value, component) => Decimal.min(value,
          new Decimal(component.availableQuantity).div(component.quantityPerBundle).floor()),
        new Decimal(Number.MAX_SAFE_INTEGER));
        if (new Decimal(line.quantity).greaterThan(available)) {
          fail("BUNDLE_STOCK_SHORTAGE",
            `${line.productName} has ${available.toString()} complete bundle${available.equals(1) ? "" : "s"} available.`,
            409, "items");
        }
        line.availableQuantity = available.toNumber();
        line.bundleComponents = components.map((component, index) => ({
          id: createId(), variantId: component.componentVariantId, offerId: component.offerId,
          productName: component.productName, variantName: component.variantName, sku: component.sku,
          quantityPerBundle: component.quantityPerBundle.toString(),
          totalQuantity: component.quantityPerBundle.times(line.quantity).toString(),
          sortOrder: index
        }));
      }
      const subtotal = lines.reduce((total, line) => total.plus(line.listTotal), new Decimal(0));
      let discountTotal = lines.reduce((total, line) => total.plus(line.discountTotal), new Decimal(0));
      const estimatedWeight = lines.reduce((total, line) => total.plus(line.estimatedWeight), new Decimal(0));
      let deliverySlot = null;
      let shippingTotal = new Decimal(0);
      if (input.deliverySlotId) {
        deliverySlot = await dao.findDeliverySlotForUpdate({ tenantId, storeId: store.id,
          slotId: input.deliverySlotId, postalCode: input.shippingAddress.postalCode, connection });
        if (!deliverySlot) fail("DELIVERY_SLOT_UNAVAILABLE", "The selected delivery slot is no longer available.", 409, "deliverySlotId");
        if (deliverySlot.reservedOrders >= deliverySlot.orderCapacity) {
          fail("DELIVERY_SLOT_FULL", "The selected delivery slot is full. Choose another slot.", 409, "deliverySlotId");
        }
        if (deliverySlot.hasPostalRules && !deliverySlot.postalSupported) {
          fail("DELIVERY_POSTAL_CODE_UNSUPPORTED", "The selected slot does not serve this PIN code.", 422, "shippingAddress.postalCode");
        }
        if (deliverySlot.weightCapacity !== null
          && new Decimal(deliverySlot.reservedWeight).plus(estimatedWeight).greaterThan(deliverySlot.weightCapacity)) {
          fail("DELIVERY_SLOT_WEIGHT_FULL", "The selected slot has insufficient weight capacity.", 409, "deliverySlotId");
        }
        shippingTotal = new Decimal(deliverySlot.deliveryFee);
      }
      let customer = await dao.findCustomer({ tenantId, email: input.customer.email,
        phone: input.customer.phone, connection });
      if (!customer) {
        customer = { id: createId() };
        await dao.insertCustomer({ customer: {
          ...input.customer, id: customer.id, tenantId,
          number: `CUS-${customer.id.replaceAll("-", "").slice(-10).toUpperCase()}`,
          notes: input.customerNotes
        }, connection });
      }
      let promotion = null; let promotionDiscount = new Decimal(0);
      let promotionShippingDiscount = new Decimal(0);
      if (input.promotionId) {
        promotion = await dao.findPromotionForOrder({ tenantId, storeId: store.id,
          promotionId: input.promotionId, customerId: customer.id,
          couponCode: input.couponCode, connection });
        if (!promotion) fail("PROMOTION_UNAVAILABLE", "The selected offer is not active for this store.", 409, "promotionId");
        if (promotion.usageLimitTotal && promotion.redemptionCount >= promotion.usageLimitTotal) {
          fail("PROMOTION_USAGE_LIMIT_REACHED", "This offer has reached its total usage limit.", 409, "promotionId");
        }
        if (promotion.usageLimitPerCustomer
          && promotion.customerRedemptionCount >= promotion.usageLimitPerCustomer) {
          fail("PROMOTION_CUSTOMER_LIMIT_REACHED", "This customer has reached the offer usage limit.", 409, "promotionId");
        }
        if (promotion.couponRequired && !input.couponCode) {
          fail("PROMOTION_COUPON_REQUIRED", "Enter a coupon code for the selected offer.", 422, "couponCode");
        }
        if (input.couponCode) {
          const now = Date.now(); const coupon = promotion.coupon;
          if (!coupon || coupon.status !== "ACTIVE" || (coupon.startsAt && new Date(coupon.startsAt).getTime() > now)
            || (coupon.endsAt && new Date(coupon.endsAt).getTime() < now)
            || (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit)) {
            fail("COUPON_UNAVAILABLE", "This coupon is invalid, inactive, expired, or fully used.", 409, "couponCode");
          }
        }
        const saleSubtotal = lines.reduce((total, line) => total.plus(line.lineTotal), new Decimal(0));
        if (saleSubtotal.lessThan(promotion.minimumOrderAmount)) {
          fail("PROMOTION_MINIMUM_NOT_MET", `This offer requires an order subtotal of at least ₹${new Decimal(promotion.minimumOrderAmount).toFixed(2)}.`, 422, "promotionId");
        }
        if (promotion.type === "PERCENTAGE") {
          promotionDiscount = saleSubtotal.times(promotion.discountValue).div(100);
          if (promotion.maxDiscountAmount) promotionDiscount = Decimal.min(promotionDiscount, promotion.maxDiscountAmount);
        } else if (promotion.type === "FIXED_AMOUNT") {
          promotionDiscount = Decimal.min(saleSubtotal, promotion.discountValue);
        } else if (promotion.type === "FREE_SHIPPING") {
          promotionDiscount = shippingTotal;
          promotionShippingDiscount = shippingTotal;
        }
        promotionDiscount = promotionDiscount.toDecimalPlaces(4);
        if (!promotionShippingDiscount.isZero() || promotionDiscount.isZero()) {
          discountTotal = discountTotal.plus(promotionShippingDiscount);
        } else {
          let allocated = new Decimal(0);
          lines.forEach((line, index) => {
            const share = index === lines.length - 1 ? promotionDiscount.minus(allocated)
              : promotionDiscount.times(line.lineTotal).div(saleSubtotal).toDecimalPlaces(4);
            allocated = allocated.plus(share); line.promotionDiscount = share;
            line.lineTotal = line.lineTotal.minus(share); line.discountTotal = line.discountTotal.plus(share);
            Object.assign(line, calculateIncludedTax({ ...line, destinationStateCode }, new Decimal(line.quantity), line.lineTotal));
          });
          discountTotal = discountTotal.plus(promotionDiscount);
        }
      }
      const taxTotal = lines.reduce((total, line) => total.plus(line.taxTotal), new Decimal(0));
      const grandTotal = subtotal.minus(discountTotal).plus(shippingTotal);
      const orderNumber = await dao.nextDocumentNumber({ tenantId, storeId: store.id,
        type: "ORDER", connection });
      if (!orderNumber) fail("ORDER_SEQUENCE_MISSING", "Order numbering is not configured for this store.", 409);
      const orderId = createId();
      const address = { ...input.shippingAddress, countryCode: "IN",
        contactName: `${input.customer.firstName} ${input.customer.lastName || ""}`.trim(),
        phone: input.customer.phone || null };
      await dao.insertOrder({ order: {
        id: orderId, tenantId, storeId: store.id, customerId: customer.id,
        deliverySlotId: deliverySlot?.id || null, number: orderNumber, currency: store.currency,
        subtotal: subtotal.toFixed(4), discountTotal: discountTotal.toFixed(4),
        shippingTotal: shippingTotal.toFixed(4), taxTotal: taxTotal.toFixed(4),
        grandTotal: grandTotal.toFixed(4), billingAddress: address, shippingAddress: address,
        customerSnapshot: { name: address.contactName, email: input.customer.email || null,
          phone: input.customer.phone || null }, customerNotes: input.customerNotes,
        internalNotes: input.internalNotes, actorUserId: context.actorUserId
      }, connection });
      if (promotion && promotionDiscount.greaterThan(0)) await dao.insertPromotionRedemption({ redemption: {
        id: createId(), tenantId, promotionId: promotion.id, couponId: promotion.coupon?.id || null,
        orderId, customerId: customer.id, discountAmount: promotionDiscount.toFixed(4)
      }, connection });
      if (deliverySlot) {
        await dao.reserveDeliverySlot({ tenantId, slot: { ...deliverySlot, reservationId: createId() },
          orderId, weight: estimatedWeight.toFixed(6), connection });
      }
      const groups = new Map();
      for (const line of lines) {
        if (!groups.has(line.merchantId)) groups.set(line.merchantId, []);
        groups.get(line.merchantId).push(line);
      }
      let sellerIndex = 0;
      for (const [merchantId, sellerLines] of groups) {
        sellerIndex += 1;
        const sellerOrderId = createId();
        const sellerNumber = await dao.nextDocumentNumber({ tenantId, storeId: store.id,
          type: "SELLER_ORDER", connection });
        if (!sellerNumber) fail("SELLER_ORDER_SEQUENCE_MISSING", "Seller order numbering is not configured for this store.", 409);
        const sellerSubtotal = sellerLines.reduce((total, line) => total.plus(line.listTotal), new Decimal(0));
        let sellerDiscount = sellerLines.reduce((total, line) => total.plus(line.discountTotal), new Decimal(0));
        if (sellerIndex === 1) sellerDiscount = sellerDiscount.plus(promotionShippingDiscount);
        const sellerShipping = sellerIndex === 1 ? shippingTotal : new Decimal(0);
        const sellerTax = sellerLines.reduce((total, line) => total.plus(line.taxTotal), new Decimal(0));
        const sellerTotal = sellerSubtotal.minus(sellerDiscount).plus(sellerShipping);
        await dao.insertSellerOrder({ sellerOrder: {
          id: sellerOrderId, tenantId, orderId, merchantId, number: sellerNumber,
          subtotal: sellerSubtotal.toFixed(4), discountTotal: sellerDiscount.toFixed(4),
          shippingTotal: sellerShipping.toFixed(4), taxTotal: sellerTax.toFixed(4),
          grandTotal: sellerTotal.toFixed(4), merchantPayableTotal: sellerTotal.toFixed(4)
        }, connection });
        for (const line of sellerLines) {
          await dao.insertOrderItem({ item: {
            id: line.itemId, tenantId, orderId, sellerOrderId, offerId: line.offerId,
            variantId: line.variantId, productName: line.productName, variantName: line.variantName,
            sku: line.sku, hsnSacCode: line.hsnSacCode, quantity: line.quantity,
            estimatedWeight: line.estimatedWeight.isZero() ? null : line.estimatedWeight.toFixed(6),
            unitPrice: new Decimal(line.salePrice).toFixed(4), listPrice: new Decimal(line.listPrice).toFixed(4),
            discountTotal: line.discountTotal.toFixed(4), taxableAmount: line.taxableAmount.toFixed(4),
            cgstRate: line.cgstRate.toFixed(6), cgstAmount: line.cgstAmount.toFixed(4),
            sgstRate: line.sgstRate.toFixed(6), sgstAmount: line.sgstAmount.toFixed(4),
            igstRate: line.igstRate.toFixed(6), igstAmount: line.igstAmount.toFixed(4),
            cessRate: line.cessRate.toFixed(6), cessAmount: line.cessAmount.toFixed(4),
            taxTotal: line.taxTotal.toFixed(4), lineTotal: line.lineTotal.toFixed(4),
            substitutionPreference: line.substitutionPreference,
            productSnapshot: { imageUrl: line.imageUrl, vertical: line.vertical,
              merchantName: line.merchantName, availableQuantityAtOrder: line.availableQuantity,
              productKind: line.productKind || "STANDARD",
              bundleComponents: line.bundleComponents?.map((component) => ({
                variantId: component.variantId, offerId: component.offerId,
                productName: component.productName, variantName: component.variantName,
                sku: component.sku, quantityPerBundle: component.quantityPerBundle,
                totalQuantity: component.totalQuantity
              })) || [],
              promotion: line.promotionDiscount?.greaterThan(0) ? { promotionId: promotion.id,
                name: promotion.name, discountAmount: line.promotionDiscount.toFixed(4) } : null,
              tax: { pricesIncludeTax: true, taxCategoryId: line.taxCategoryId,
                taxRateId: line.taxRateId, hsnSacCode: line.hsnSacCode,
                sellerGstin: line.registrationGstin,
                originStateCode: normalizeGstStateCode(line.registrationStateCode),
                destinationStateCode: line.destinationStateCode,
                supplyType: line.intraState ? "INTRA_STATE" : "INTER_STATE" } }
          }, connection });
          for (const component of line.bundleComponents || []) {
            await dao.insertOrderItemBundleComponent({ component: { ...component,
              tenantId, orderItemId: line.itemId }, connection });
          }
        }
      }
      await dao.insertStatusHistory({ entry: {
        id: createId(), tenantId, orderId, previousStatus: null, newStatus: "PLACED",
        reasonCode: "MANUAL_ENTRY", notes: input.internalNotes || null, actorUserId: context.actorUserId
      }, connection });
      await dao.insertAudit({ audit: {
        id: createId(), tenantId, actorUserId: context.actorUserId, action: "ORDER_CREATED",
        orderId, requestId: context.requestId, ipAddress: context.ipAddress || "127.0.0.1",
        userAgent: context.userAgent, beforeData: null,
        afterData: { orderNumber, source: "MANUAL", grandTotal: grandTotal.toFixed(4),
          itemCount: lines.length, sellerCount: groups.size,
          promotionId: promotion?.id || null, couponCode: promotion?.coupon?.code || null,
          promotionDiscount: promotionDiscount.toFixed(4) }
      }, connection });
      await dao.insertOutbox({ event: {
        id: createId(), tenantId, orderId, type: "order.created",
        payload: { orderId, orderNumber, source: "MANUAL", grandTotal: grandTotal.toFixed(4) }
      }, connection });
      return dao.getOrder({ tenantId, orderId, connection });
    });
  }

  async function getOrder(tenantId, orderId) {
    const order = await dao.getOrder({ tenantId, orderId });
    if (!order) fail("ORDER_NOT_FOUND", "Order was not found.", 404);
    return order;
  }

  async function getFulfillmentOptions(tenantId, orderId) {
    const options = await dao.getFulfillmentOptions({ tenantId, orderId });
    if (!options) fail("ORDER_NOT_FOUND", "Order was not found.", 404);
    return options;
  }

  async function allocateFulfillment(tenantId, orderId, input, context, scope = {}) {
    return transaction(tenantId, async (connection) => {
      const sellerOrder = await dao.findSellerOrderForFulfillment({ tenantId, orderId,
        sellerOrderId: input.sellerOrderId, connection });
      if (!sellerOrder) fail("SELLER_ORDER_NOT_FOUND", "The seller order was not found.", 404, "sellerOrderId");
      if (scope.merchantId && sellerOrder.merchantId !== scope.merchantId) {
        fail("SELLER_ORDER_NOT_FOUND", "The seller order was not found.", 404, "sellerOrderId");
      }
      if (!["CONFIRMED", "PROCESSING"].includes(sellerOrder.orderStatus)) {
        fail("ORDER_NOT_READY_FOR_FULFILLMENT", "Confirm the order before allocating warehouse stock.", 409);
      }
      if (sellerOrder.hasFulfillment || sellerOrder.fulfillmentStatus === "FULFILLED") {
        fail("FULFILLMENT_ALREADY_EXISTS", "This seller order already has a fulfilment.", 409, "sellerOrderId");
      }
      const warehouse = await dao.findWarehouseForFulfillment({ tenantId,
        warehouseId: input.warehouseId, merchantId: sellerOrder.merchantId,
        storeId: sellerOrder.storeId, connection });
      if (!warehouse) {
        fail("WAREHOUSE_SCOPE_MISMATCH", "Select an active warehouse owned by this seller.", 422, "warehouseId");
      }
      const serialMap = new Map(input.serialAssignments.map((assignment) =>
        [assignment.bundleComponentId || assignment.orderItemId, assignment.serialIds]));
      if (serialMap.size !== input.serialAssignments.length) {
        fail("FULFILLMENT_SERIAL_ASSIGNMENT_DUPLICATE",
          "Each stock line can have only one serial-number selection.", 422, "serialAssignments");
      }
      const fulfillmentId = createId();
      await dao.insertFulfillment({ fulfillment: { id: fulfillmentId, tenantId,
        sellerOrderId: sellerOrder.id, warehouseId: warehouse.id,
        number: documentNumber("FUL", fulfillmentId), actorUserId: context.actorUserId,
        notes: input.notes }, connection });

      for (const item of sellerOrder.items) {
        const balance = await dao.findBalanceForFulfillment({ tenantId,
          warehouseId: warehouse.id, offerId: item.offerId, connection });
        if (!balance) fail("FULFILLMENT_STOCK_MISSING",
          `${item.productName} has no stock in ${warehouse.name}.`, 409, "warehouseId");
        const available = new Decimal(balance.onHandQuantity).minus(balance.reservedQuantity)
          .minus(balance.quarantineQuantity);
        const requested = new Decimal(item.quantity);
        if (available.lessThan(requested)) {
          fail("FULFILLMENT_STOCK_SHORTAGE",
            `${item.productName} has ${available.toString()} available; ${requested.toString()} required.`, 409, "warehouseId");
        }
        const allocationId = item.bundleComponentId || item.orderItemId || item.id;
        const selectedSerialIds = serialMap.get(allocationId) || [];
        let selectedSerials = [];
        if (item.serialTracking) {
          if (!requested.isInteger() || selectedSerialIds.length !== requested.toNumber()) {
            fail("FULFILLMENT_SERIAL_COUNT_MISMATCH",
              `Select exactly ${requested.toString()} serial number${requested.equals(1) ? "" : "s"} for ${item.productName}.`, 422, "serialAssignments");
          }
          selectedSerials = await dao.listSerialsForFulfillment({ tenantId,
            balanceId: balance.id, serialIds: selectedSerialIds, connection });
          if (selectedSerials.length !== selectedSerialIds.length) {
            fail("FULFILLMENT_SERIAL_UNAVAILABLE",
              `One or more serial numbers for ${item.productName} are no longer available.`, 409, "serialAssignments");
          }
        } else if (selectedSerialIds.length) {
          fail("FULFILLMENT_SERIAL_NOT_SUPPORTED",
            `${item.productName} is not serial tracked.`, 422, "serialAssignments");
        }

        const allocations = [];
        if (item.lotTracking) {
          const lots = await dao.listLotsForFulfillment({ tenantId, balanceId: balance.id, connection });
          let remaining = requested;
          for (const lot of lots) {
            if (remaining.isZero()) break;
            const lotAvailable = new Decimal(lot.onHandQuantity).minus(lot.reservedQuantity)
              .minus(lot.quarantineQuantity);
            if (lotAvailable.lessThanOrEqualTo(0)) continue;
            const quantity = Decimal.min(remaining, lotAvailable);
            allocations.push({ lotId: lot.id, quantity });
            remaining = remaining.minus(quantity);
          }
          if (!remaining.isZero()) {
            fail("FULFILLMENT_LOT_SHORTAGE",
              `${item.productName} does not have enough usable batch stock.`, 409, "warehouseId");
          }
        } else {
          allocations.push({ lotId: null, quantity: requested });
        }

        let serialIndex = 0;
        for (const allocation of allocations) {
          const fulfillmentItemId = createId();
          await dao.insertFulfillmentItem({ item: { id: fulfillmentItemId, fulfillmentId,
            orderItemId: item.orderItemId || item.id,
            bundleComponentId: item.bundleComponentId || null, lotId: allocation.lotId,
            quantity: allocation.quantity.toString() }, connection });
          await dao.reserveFulfillmentStock({ reservation: { id: createId(), tenantId,
            balanceId: balance.id, lotId: allocation.lotId, fulfillmentId,
            quantity: allocation.quantity.toString() }, connection });
          if (item.serialTracking) {
            const count = allocation.quantity.toNumber();
            for (const serial of selectedSerials.slice(serialIndex, serialIndex + count)) {
              await dao.reserveFulfillmentSerial({ fulfillmentItemId, serialId: serial.id, connection });
            }
            serialIndex += count;
          }
        }
      }
      await dao.markFulfillmentAllocated({ tenantId, orderId,
        sellerOrderId: sellerOrder.id, connection });
      await dao.insertStatusHistory({ entry: { id: createId(), tenantId, orderId,
        type: "FULFILLMENT", previousStatus: sellerOrder.fulfillmentStatus,
        newStatus: "PROCESSING", reasonCode: "WAREHOUSE_ALLOCATED",
        notes: `${warehouse.name} · ${documentNumber("FUL", fulfillmentId)}`,
        actorUserId: context.actorUserId }, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId,
        actorUserId: context.actorUserId, action: "FULFILLMENT_ALLOCATED", orderId,
        requestId: context.requestId, ipAddress: context.ipAddress || "127.0.0.1",
        userAgent: context.userAgent, beforeData: null,
        afterData: { fulfillmentId, sellerOrderId: sellerOrder.id, warehouseId: warehouse.id,
          itemCount: sellerOrder.items.length } }, connection });
      await dao.insertOutbox({ event: { id: createId(), tenantId, orderId,
        type: "order.fulfillment.allocated", payload: { orderId, fulfillmentId,
          sellerOrderId: sellerOrder.id, warehouseId: warehouse.id } }, connection });
      return dao.getOrder({ tenantId, orderId, connection });
    });
  }

  async function transitionFulfillment(tenantId, orderId, fulfillmentId, input, context, scope = {}) {
    return transaction(tenantId, async (connection) => {
      const fulfillment = await dao.findFulfillmentForUpdate({ tenantId, orderId,
        fulfillmentId, connection });
      if (!fulfillment) fail("FULFILLMENT_NOT_FOUND", "The fulfilment was not found.", 404);
      if (scope.merchantId && fulfillment.merchantId !== scope.merchantId) {
        fail("FULFILLMENT_NOT_FOUND", "The fulfilment was not found.", 404);
      }
      if (!(fulfillmentTransitions[fulfillment.status] || []).includes(input.status)) {
        fail("INVALID_FULFILLMENT_TRANSITION",
          `${fulfillment.status.toLowerCase()} fulfilments cannot move to ${input.status.toLowerCase()}.`, 409, "status");
      }
      let shipmentId = fulfillment.shipmentId;
      if (input.status === "DISPATCHED") {
        const stocks = await dao.listFulfillmentStock({ tenantId, fulfillmentId, connection });
        if (!stocks.length) fail("FULFILLMENT_RESERVATION_MISSING",
          "Reserved stock could not be found for this fulfilment.", 409);
        const serials = await dao.listFulfillmentSerials({ fulfillmentId, connection });
        for (const stock of stocks) {
          await dao.consumeFulfillmentStock({ stock: { ...stock, ledgerId: createId() },
            tenantId, fulfillmentId, actorUserId: context.actorUserId, connection });
          for (const serial of serials.filter((entry) => entry.fulfillmentItemId === stock.fulfillmentItemId)) {
            await dao.markSerialSold({ serial: { ...serial,
              warrantyMonths: stock.warrantyMonths }, connection });
            if (stock.warrantyMonths && stock.warrantyType) {
              await dao.insertWarrantyRegistration({ warranty: { id: createId(), tenantId,
                orderItemId: stock.orderItemId, serialId: serial.id,
                customerId: fulfillment.customerId, type: stock.warrantyType,
                months: stock.warrantyMonths }, connection });
            }
          }
        }
        shipmentId = createId();
        await dao.insertShipment({ shipment: { id: shipmentId, tenantId, fulfillmentId,
          number: documentNumber("SHP", shipmentId), providerCode: input.providerCode,
          serviceCode: input.serviceCode, trackingNumber: input.trackingNumber,
          packageCount: input.packageCount, packageWeight: input.packageWeight }, connection });
        await dao.insertTrackingEvent({ event: { id: createId(), tenantId, shipmentId,
          code: "MANUAL_DISPATCH", status: "SHIPPED",
          description: input.notes || "Shipment dispatched by the operations team.",
          location: input.location }, connection });
        await dao.markFulfillmentDispatched({ tenantId, orderId,
          sellerOrderId: fulfillment.sellerOrderId, connection });
      }
      await dao.updateFulfillmentStage({ tenantId, fulfillmentId,
        status: input.status, connection });
      const itemStatus = { PICKING: "PICKING", PACKED: "PACKED",
        DISPATCHED: "SHIPPED", COMPLETED: "FULFILLED" }[input.status];
      await dao.updateFulfillmentOrderItems({ fulfillmentId, status: itemStatus, connection });
      let orderFulfillmentStatus = fulfillment.orderFulfillmentStatus;
      if (input.status === "COMPLETED") {
        orderFulfillmentStatus = await dao.markFulfillmentCompleted({ tenantId, orderId,
          sellerOrderId: fulfillment.sellerOrderId, fulfillmentId, connection });
        await financeService.postCompletedOrderLedger(tenantId, orderId, context, connection);
        if (shipmentId) {
          await dao.insertTrackingEvent({ event: { id: createId(), tenantId, shipmentId,
            code: "MANUAL_DELIVERY", status: "DELIVERED",
            description: input.notes || "Delivery confirmed by the operations team.",
            location: input.location }, connection });
        }
      }
      await dao.insertStatusHistory({ entry: { id: createId(), tenantId, orderId,
        type: "FULFILLMENT", previousStatus: fulfillment.status,
        newStatus: input.status, reasonCode: `FULFILLMENT_${input.status}`,
        notes: input.notes, actorUserId: context.actorUserId }, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId,
        actorUserId: context.actorUserId, action: "FULFILLMENT_STATUS_CHANGED", orderId,
        requestId: context.requestId, ipAddress: context.ipAddress || "127.0.0.1",
        userAgent: context.userAgent, beforeData: { status: fulfillment.status },
        afterData: { fulfillmentId, status: input.status, orderFulfillmentStatus,
          trackingNumber: input.trackingNumber || null } }, connection });
      await dao.insertOutbox({ event: { id: createId(), tenantId, orderId,
        type: "order.fulfillment.status-changed", payload: { orderId, fulfillmentId,
          previousStatus: fulfillment.status, status: input.status } }, connection });
      return dao.getOrder({ tenantId, orderId, connection });
    });
  }

  async function transitionOrder(tenantId, orderId, input, context) {
    return transaction(tenantId, async (connection) => {
      const order = await dao.findOrderForUpdate({ tenantId, orderId, connection });
      if (!order) fail("ORDER_NOT_FOUND", "Order was not found.", 404);
      if (!(transitions[order.status] || []).includes(input.status)) {
        fail("INVALID_ORDER_TRANSITION",
          `${order.status.toLowerCase()} orders cannot move to ${input.status.toLowerCase()}.`, 409, "status");
      }
      if (input.status === "CANCELLED"
        && await dao.hasDispatchedFulfillment({ tenantId, orderId, connection })) {
        fail("DISPATCHED_ORDER_CANNOT_BE_CANCELLED",
          "A dispatched order cannot be cancelled. Use the returns workflow after delivery.", 409, "status");
      }
      await dao.updateOrderStatus({ tenantId, orderId, status: input.status, connection });
      if (input.status === "COMPLETED") {
        await financeService.postCompletedOrderLedger(tenantId, orderId, context, connection);
      }
      if (input.status === "CANCELLED") {
        await dao.releaseDeliverySlot({ tenantId, orderId, connection });
        await dao.releaseFulfillmentReservations({ tenantId, orderId, connection });
        await dao.reversePromotionRedemption({ tenantId, orderId, connection });
      }
      await dao.insertStatusHistory({ entry: {
        id: createId(), tenantId, orderId, previousStatus: order.status,
        newStatus: input.status, reasonCode: input.reasonCode,
        notes: input.notes, actorUserId: context.actorUserId
      }, connection });
      await dao.insertAudit({ audit: {
        id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "ORDER_STATUS_CHANGED", orderId, requestId: context.requestId,
        ipAddress: context.ipAddress || "127.0.0.1", userAgent: context.userAgent,
        beforeData: { status: order.status }, afterData: {
          status: input.status, reasonCode: input.reasonCode || null, notes: input.notes || null
        }
      }, connection });
      await dao.insertOutbox({ event: {
        id: createId(), tenantId, orderId, type: "order.status.changed",
        payload: { orderId, previousStatus: order.status, status: input.status }
      }, connection });
      return dao.getOrder({ tenantId, orderId, connection });
    });
  }

  return { listCreationOptions, listOrders, createOrder, getOrder, getFulfillmentOptions,
    allocateFulfillment, transitionFulfillment, transitionOrder };
}

const ordersService = createOrdersService();
export const { listCreationOptions, listOrders, createOrder, getOrder, getFulfillmentOptions,
  allocateFulfillment, transitionFulfillment, transitionOrder } = ordersService;
