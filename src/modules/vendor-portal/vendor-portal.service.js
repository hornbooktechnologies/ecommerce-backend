import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as dao from "../vendors/vendors.dao.js";
import * as orderDao from "../orders/orders.dao.js";
import { createOrdersService } from "../orders/orders.service.js";
import * as vendorOrderDao from "./vendor-orders.dao.js";

const ordersService = createOrdersService();

function contextOf(requestContext) { return { actorUserId: requestContext.actorUserId,
  requestId: requestContext.requestId, ipAddress: requestContext.ipAddress, userAgent: requestContext.userAgent }; }
function requireActive(vendor) {
  if (vendor.status !== "ACTIVE") throw new AppError({ code: "VENDOR_SUSPENDED",
    message: "This vendor is not active. Contact the marketplace administrator.", status: 409 });
}

export async function getWorkspace(tenantId, merchantId) {
  const workspace = await dao.getVendor({ tenantId, vendorId: merchantId });
  if (!workspace) throw new AppError({ code: "VENDOR_NOT_FOUND", message: "Vendor was not found.", status: 404 });
  return workspace;
}

export async function updateProfile(tenantId, merchantId, input, requestContext) {
  return withTransaction(tenantId, async (connection) => {
    const current = await dao.getVendor({ tenantId, vendorId: merchantId, connection, forUpdate: true });
    if (!current) throw new AppError({ code: "VENDOR_NOT_FOUND", message: "Vendor was not found.", status: 404 });
    requireActive(current.vendor);
    await dao.updateVendor({ tenantId, vendorId: merchantId, changes: input, connection });
    await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: requestContext.actorUserId,
      action: "vendor.profile.self_updated", entityType: "VENDOR", entityId: merchantId,
      ...contextOf(requestContext), beforeData: null, afterData: { changedFields: Object.keys(input) } }, connection });
    return dao.getVendor({ tenantId, vendorId: merchantId, connection });
  });
}

export async function updateOffer(tenantId, merchantId, offerId, input, requestContext) {
  return withTransaction(tenantId, async (connection) => {
    const vendor = await dao.getVendor({ tenantId, vendorId: merchantId, connection, forUpdate: true });
    if (!vendor) throw new AppError({ code: "VENDOR_NOT_FOUND", message: "Vendor was not found.", status: 404 });
    requireActive(vendor.vendor);
    const current = await dao.findVendorOffer({ tenantId, vendorId: merchantId, offerId, connection, forUpdate: true });
    if (!current) throw new AppError({ code: "VENDOR_OFFER_NOT_FOUND", message: "Offer was not found.", status: 404 });
    const listPrice = input.listPrice ?? current.listPrice;
    const salePrice = input.salePrice ?? current.salePrice;
    const costPrice = input.costPrice !== undefined ? input.costPrice : current.costPrice;
    if (salePrice > listPrice) throw new AppError({ code: "OFFER_PRICE_INVALID",
      message: "Selling price cannot exceed MRP.", status: 422 });
    await dao.updateVendorOffer({ offerId, status: input.status, handlingTimeHours: input.handlingTimeHours, connection });
    if (input.listPrice !== undefined || input.salePrice !== undefined || input.costPrice !== undefined) {
      if (!current.priceListId) throw new AppError({ code: "OFFER_PRICE_LIST_MISSING",
        message: "The offer does not have an active INR price list.", status: 409 });
      await dao.closeOfferPrice({ offerId, priceListId: current.priceListId, connection });
      await dao.insertOfferPrice({ price: { id: createId(), tenantId, offerId,
        priceListId: current.priceListId, listPrice, salePrice, costPrice }, connection });
    }
    await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: requestContext.actorUserId,
      action: "vendor.offer.self_updated", entityType: "SELLER_OFFER", entityId: offerId,
      ...contextOf(requestContext), beforeData: { status: current.status, listPrice: current.listPrice,
        salePrice: current.salePrice }, afterData: input }, connection });
    return dao.getVendor({ tenantId, vendorId: merchantId, connection });
  });
}

export async function listOrders(tenantId, merchantId, filters) {
  return vendorOrderDao.listSellerOrders({ tenantId, merchantId, filters });
}

export async function getOrder(tenantId, merchantId, sellerOrderId) {
  const result = await vendorOrderDao.getSellerOrder({ tenantId, merchantId, sellerOrderId });
  if (!result) throw new AppError({ code: "VENDOR_ORDER_NOT_FOUND",
    message: "Seller order was not found.", status: 404 });
  return result;
}

export async function decideOrder(tenantId, merchantId, sellerOrderId, input, requestContext) {
  return withTransaction(tenantId, async (connection) => {
    const current = await vendorOrderDao.getSellerOrder({ tenantId, merchantId,
      sellerOrderId, connection, forUpdate: true });
    if (!current) throw new AppError({ code: "VENDOR_ORDER_NOT_FOUND",
      message: "Seller order was not found.", status: 404 });
    requireActive({ status: current.order.merchantStatus });
    if (!["PENDING", "PLACED"].includes(current.order.status)) {
      throw new AppError({ code: "VENDOR_ORDER_DECISION_INVALID",
        message: `This order is already ${current.order.status.toLowerCase()} and cannot be decided again.`, status: 409 });
    }
    const nextStatus = input.action === "ACCEPT" ? "CONFIRMED" : "CANCELLED";
    const parentStatus = await vendorOrderDao.updateSellerOrderDecision({ tenantId, merchantId,
      sellerOrderId, orderId: current.order.customerOrderId, action: input.action, connection });
    if (parentStatus === "CANCELLED") {
      await orderDao.releaseDeliverySlot({ tenantId, orderId: current.order.customerOrderId, connection });
    }
    await orderDao.insertStatusHistory({ entry: { id: createId(), tenantId,
      orderId: current.order.customerOrderId, sellerOrderId, type: "SELLER_ORDER",
      previousStatus: current.order.status, newStatus: nextStatus,
      reasonCode: input.reasonCode || (input.action === "ACCEPT" ? "VENDOR_ACCEPTED" : "VENDOR_REJECTED"),
      notes: input.notes, actorUserId: requestContext.actorUserId }, connection });
    await orderDao.insertAudit({ audit: { id: createId(), tenantId,
      actorUserId: requestContext.actorUserId, action: `VENDOR_ORDER_${input.action}ED`,
      orderId: current.order.customerOrderId, requestId: requestContext.requestId,
      ipAddress: requestContext.ipAddress || "127.0.0.1", userAgent: requestContext.userAgent,
      beforeData: { sellerOrderId, status: current.order.status },
      afterData: { sellerOrderId, status: nextStatus, parentStatus } }, connection });
    await orderDao.insertOutbox({ event: { id: createId(), tenantId,
      orderId: current.order.customerOrderId, type: `vendor.order.${input.action.toLowerCase()}ed`,
      payload: { sellerOrderId, merchantId, status: nextStatus, parentStatus } }, connection });
    return vendorOrderDao.getSellerOrder({ tenantId, merchantId, sellerOrderId, connection });
  });
}

export async function getFulfillmentOptions(tenantId, merchantId, sellerOrderId) {
  const current = await getOrder(tenantId, merchantId, sellerOrderId);
  const options = await ordersService.getFulfillmentOptions(tenantId, current.order.customerOrderId);
  const sellerOrder = options.sellerOrders.find((entry) => entry.id === sellerOrderId
    && entry.merchantId === merchantId);
  if (!sellerOrder) throw new AppError({ code: "VENDOR_ORDER_NOT_FOUND",
    message: "Seller order was not found.", status: 404 });
  const itemIds = new Set(sellerOrder.items.map((item) => item.id));
  const warehouses = options.warehouses.filter((warehouse) => warehouse.merchantId === merchantId);
  const warehouseIds = new Set(warehouses.map((warehouse) => warehouse.id));
  return { order: current.order, sellerOrder, warehouses,
    inventory: options.inventory.filter((entry) => itemIds.has(entry.allocationId)
      && warehouseIds.has(entry.warehouseId)) };
}

export async function allocateFulfillment(tenantId, merchantId, sellerOrderId, input, requestContext) {
  const current = await getOrder(tenantId, merchantId, sellerOrderId);
  await ordersService.allocateFulfillment(tenantId, current.order.customerOrderId,
    { ...input, sellerOrderId }, requestContext, { merchantId });
  return getOrder(tenantId, merchantId, sellerOrderId);
}

export async function transitionFulfillment(tenantId, merchantId, sellerOrderId,
  fulfillmentId, input, requestContext) {
  const current = await getOrder(tenantId, merchantId, sellerOrderId);
  if (!current.fulfillments.some((entry) => entry.id === fulfillmentId)) {
    throw new AppError({ code: "FULFILLMENT_NOT_FOUND", message: "The fulfilment was not found.", status: 404 });
  }
  await ordersService.transitionFulfillment(tenantId, current.order.customerOrderId,
    fulfillmentId, input, requestContext, { merchantId });
  return getOrder(tenantId, merchantId, sellerOrderId);
}
