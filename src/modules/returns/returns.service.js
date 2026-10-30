import Decimal from "decimal.js";
import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./returns.dao.js";

function documentNumber(prefix, id) {
  return `${prefix}-${id.replaceAll("-", "").slice(-12).toUpperCase()}`;
}

function fail(code, message, status = 422, field = null) {
  throw new AppError({ code, message, status,
    details: field ? [{ field, code: code.toLowerCase(), message }] : [] });
}

export function createReturnsService({ dao = defaultDao, transaction = withTransaction } = {}) {
  const requireReturn = async (tenantId, returnId, connection, forUpdate = false) => {
    const result = await dao.getReturn({ tenantId, returnId, connection, forUpdate });
    if (!result) fail("RETURN_NOT_FOUND", "Return request was not found.", 404);
    return result;
  };

  async function audit(tenantId, entityId, action, beforeData, afterData, context, connection, entityType = "RETURN_REQUEST") {
    await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
      action, entityType, entityId, requestId: context.requestId, ipAddress: context.ipAddress,
      userAgent: context.userAgent, beforeData, afterData }, connection });
  }

  async function listReturnOptions(tenantId) { return dao.listReturnOptions({ tenantId }); }
  async function listReturns(tenantId, filters) { return dao.listReturns({ tenantId, filters }); }
  async function getReturn(tenantId, returnId) { return requireReturn(tenantId, returnId); }

  async function createReturn(tenantId, input, context) {
    return transaction(tenantId, async (connection) => {
      const orderItem = await dao.findOrderItemForReturn({ tenantId, orderItemId: input.orderItemId, connection });
      if (!orderItem || !orderItem.isReturnable || !["FULFILLED", "PARTIALLY_FULFILLED"].includes(orderItem.fulfillmentStatus)) {
        fail("RETURN_ITEM_INELIGIBLE", "This order item is not eligible for return.", 409, "orderItemId");
      }
      const remaining = new Decimal(orderItem.quantity).minus(orderItem.returnedQuantity);
      const quantity = new Decimal(input.quantity);
      if (quantity.greaterThan(remaining)) {
        fail("RETURN_QUANTITY_EXCEEDS_ELIGIBLE", `Only ${remaining.toString()} units remain eligible.`, 409, "quantity");
      }
      if (input.returnType === "EXCHANGE" && orderItem.vertical !== "CLOTHING") {
        fail("EXCHANGE_REQUIRES_CLOTHING", "Only clothing items can use the size or colour exchange workflow.", 422, "returnType");
      }
      let serials = [];
      if (orderItem.serialTracking) {
        const serialUnits = new Decimal(orderItem.bundleSerialUnits || 1);
        const expectedSerials = quantity.times(serialUnits);
        if (!quantity.isInteger() || !expectedSerials.isInteger()
          || input.serialIds.length !== expectedSerials.toNumber()) {
          fail("RETURN_SERIALS_REQUIRED",
            `Select ${serialUnits.toString()} sold serial number${serialUnits.equals(1) ? "" : "s"} for every returned unit.`,
            422, "serialIds");
        }
        serials = await dao.findSoldSerials({ tenantId, orderItemId: input.orderItemId,
          serialIds: input.serialIds, connection });
        if (serials.length !== input.serialIds.length) {
          fail("RETURN_SERIAL_INVALID", "One or more serial numbers are not eligible for this order item.", 409, "serialIds");
        }
      } else if (input.serialIds.length) {
        fail("RETURN_SERIAL_NOT_ALLOWED", "Serial numbers apply only to serial-tracked products.", 422, "serialIds");
      }
      const id = createId();
      const number = await dao.nextReturnNumber({ tenantId, storeId: orderItem.storeId, connection })
        || documentNumber("RET", id);
      await dao.insertReturnRequest({ record: { id, tenantId, orderId: orderItem.orderId,
        sellerOrderId: orderItem.sellerOrderId, number, type: input.returnType,
        reasonCode: input.reasonCode, customerComments: input.customerComments,
        actorUserId: context.actorUserId }, connection });
      if (orderItem.bundleSerialUnits > 0) {
        const returnItemId = createId();
        await dao.insertReturnItem({ item: { id: returnItemId, returnId: id,
          orderItemId: orderItem.id, serialId: null, quantity: quantity.toString(),
          reasonCode: input.reasonCode }, connection });
        for (const serial of serials) {
          const linked = await dao.insertReturnBundleSerial({ link: { id: createId(),
            returnItemId, orderItemId: orderItem.id, serialId: serial.id }, connection });
          if (!linked) fail("RETURN_SERIAL_INVALID",
            "A selected serial number is not part of this bundle order.", 409, "serialIds");
        }
      } else if (orderItem.serialTracking) {
        for (const serial of serials) {
          await dao.insertReturnItem({ item: { id: createId(), returnId: id, orderItemId: orderItem.id,
            serialId: serial.id, quantity: 1, reasonCode: input.reasonCode }, connection });
        }
      } else {
        await dao.insertReturnItem({ item: { id: createId(), returnId: id, orderItemId: orderItem.id,
          serialId: null, quantity: quantity.toString(), reasonCode: input.reasonCode }, connection });
      }
      await audit(tenantId, id, "return.created", null, { number, type: input.returnType,
        orderItemId: orderItem.id, quantity: quantity.toString() }, context, connection);
      return dao.getReturn({ tenantId, returnId: id, connection });
    });
  }

  async function approveReturn(tenantId, returnId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await requireReturn(tenantId, returnId, connection, true);
      if (current.request.status !== "REQUESTED") fail("RETURN_STATUS_INVALID", "Only requested returns can be approved.", 409);
      await dao.approveReturnItems({ returnId, connection });
      await dao.updateReturnStatus({ tenantId, returnId, fromStatus: "REQUESTED", toStatus: "APPROVED",
        actorUserId: context.actorUserId, notes: input.notes, connection });
      await audit(tenantId, returnId, "return.approved", { status: "REQUESTED" }, { status: "APPROVED" }, context, connection);
      return dao.getReturn({ tenantId, returnId, connection });
    });
  }

  async function rejectReturn(tenantId, returnId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await requireReturn(tenantId, returnId, connection, true);
      if (current.request.status !== "REQUESTED") fail("RETURN_STATUS_INVALID", "Only requested returns can be rejected.", 409);
      await dao.updateReturnStatus({ tenantId, returnId, fromStatus: "REQUESTED", toStatus: "REJECTED",
        actorUserId: context.actorUserId, notes: input.notes, connection });
      await audit(tenantId, returnId, "return.rejected", { status: "REQUESTED" },
        { status: "REJECTED", notes: input.notes }, context, connection);
      return dao.getReturn({ tenantId, returnId, connection });
    });
  }

  async function receiveReturn(tenantId, returnId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await requireReturn(tenantId, returnId, connection, true);
      if (current.request.status !== "APPROVED") fail("RETURN_STATUS_INVALID", "Approve the return before receiving it.", 409);
      const options = await dao.listReturnOptions({ tenantId, connection });
      if (!options.warehouses.some((warehouse) => warehouse.id === input.warehouseId)) {
        fail("RETURN_WAREHOUSE_INVALID", "Select an active receiving warehouse.", 422, "warehouseId");
      }
      await dao.receiveReturnItems({ returnId, connection });
      await dao.updateReturnStatus({ tenantId, returnId, fromStatus: "APPROVED", toStatus: "RECEIVED",
        actorUserId: context.actorUserId, notes: input.notes, warehouseId: input.warehouseId, connection });
      await audit(tenantId, returnId, "return.received", { status: "APPROVED" },
        { status: "RECEIVED", warehouseId: input.warehouseId }, context, connection);
      return dao.getReturn({ tenantId, returnId, connection });
    });
  }

  async function inspectReturn(tenantId, returnId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await requireReturn(tenantId, returnId, connection, true);
      if (current.request.status !== "RECEIVED") fail("RETURN_STATUS_INVALID", "Receive the return before inspection.", 409);
      if (!current.request.warehouseId) fail("RETURN_WAREHOUSE_REQUIRED", "A receiving warehouse is required.", 409);
      const items = await dao.listReturnItemsForDisposition({ tenantId, returnId, connection });
      for (const item of items) {
        const refundAmount = new Decimal(item.lineTotal).times(item.quantity).dividedBy(item.orderedQuantity)
          .toDecimalPlaces(4).toString();
        await dao.inspectReturnItem({ itemId: item.id, condition: input.itemCondition,
          disposition: input.disposition, notes: input.notes, refundAmount, connection });
        if (item.isBundle) continue;
        if (input.disposition === "SCRAP") {
          if (item.serialId) await dao.markSerialDisposition({ serialId: item.serialId, status: "SCRAPPED", connection });
          continue;
        }
        const balanceId = await dao.findOrCreateBalance({ id: createId(), tenantId,
          warehouseId: current.request.warehouseId, offerId: item.offerId, connection });
        const quarantine = input.disposition === "QUARANTINE";
        await dao.addReturnedStock({ tenantId, balanceId, quantity: item.quantity, quarantine, connection });
        let lotId = null;
        if (item.lotTracking) {
          lotId = await dao.upsertReturnLot({ lot: { id: createId(), tenantId, balanceId,
            number: `RETURN-${current.request.returnNumber}`, quantity: item.quantity, quarantine }, connection });
        }
        if (item.serialId) {
          await dao.updateReturnedSerial({ serialId: item.serialId, balanceId, lotId,
            status: quarantine ? "QUARANTINED" : "AVAILABLE", connection });
        }
        await dao.insertStockLedger({ entry: { id: createId(), tenantId, balanceId, lotId,
          serialId: item.serialId, quantity: item.quantity, quarantine, returnId,
          reasonCode: current.request.reasonCode, notes: input.notes, actorUserId: context.actorUserId }, connection });
      }
      const bundleStock = await dao.listBundleReturnStock({ tenantId, returnId, connection });
      for (const component of bundleStock) {
        if (input.disposition === "SCRAP") {
          if (component.serialId) await dao.markSerialDisposition({ serialId: component.serialId,
            status: "SCRAPPED", connection });
          continue;
        }
        const balanceId = await dao.findOrCreateBalance({ id: createId(), tenantId,
          warehouseId: current.request.warehouseId, offerId: component.offerId, connection });
        const quarantine = input.disposition === "QUARANTINE";
        await dao.addReturnedStock({ tenantId, balanceId, quantity: component.quantity,
          quarantine, connection });
        let lotId = null;
        if (component.lotTracking) {
          lotId = await dao.upsertReturnLot({ lot: { id: createId(), tenantId, balanceId,
            number: `RETURN-${current.request.returnNumber}`, quantity: component.quantity,
            quarantine }, connection });
        }
        if (component.serialId) {
          await dao.updateReturnedSerial({ serialId: component.serialId, balanceId, lotId,
            status: quarantine ? "QUARANTINED" : "AVAILABLE", connection });
        }
        await dao.insertStockLedger({ entry: { id: createId(), tenantId, balanceId, lotId,
          serialId: component.serialId, quantity: component.quantity, quarantine, returnId,
          reasonCode: current.request.reasonCode, notes: input.notes,
          actorUserId: context.actorUserId }, connection });
      }
      // End the original sale's coverage atomically with stock disposition. A
      // returned unit may become available for a new sale immediately after commit.
      const voidedWarrantyCount = await dao.voidReturnedWarranties({ tenantId, returnId, connection });
      await dao.updateReturnStatus({ tenantId, returnId, fromStatus: "RECEIVED", toStatus: "INSPECTED",
        actorUserId: context.actorUserId, notes: input.notes, connection });
      await audit(tenantId, returnId, "return.inspected", { status: "RECEIVED" },
        { status: "INSPECTED", condition: input.itemCondition, disposition: input.disposition,
          voidedWarrantyCount }, context, connection);
      return dao.getReturn({ tenantId, returnId, connection });
    });
  }

  async function completeReturn(tenantId, returnId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await requireReturn(tenantId, returnId, connection, true);
      if (current.request.status !== "INSPECTED") fail("RETURN_STATUS_INVALID", "Inspect the return before completing it.", 409);
      if (current.request.returnType === "EXCHANGE") {
        fail("RETURN_EXCHANGE_PENDING", "Create and complete the replacement exchange to close this return.", 409);
      }
      const amount = current.items.reduce((total, item) => total.plus(item.refundAmount || 0), new Decimal(0));
      if (amount.greaterThan(0)) {
        const grouped = new Map();
        for (const item of current.items) {
          const existing = grouped.get(item.orderItemId) || { quantity: new Decimal(0), amount: new Decimal(0) };
          existing.quantity = existing.quantity.plus(item.approvedQuantity);
          existing.amount = existing.amount.plus(item.refundAmount || 0);
          grouped.set(item.orderItemId, existing);
        }
        const refundId = createId();
        await dao.insertRefund({ refund: { id: refundId, tenantId, orderId: current.request.orderId,
          number: documentNumber("RFN", refundId), reasonCode: current.request.reasonCode,
          amount: amount.toFixed(4), reference: input.refundReference, notes: input.notes,
          actorUserId: context.actorUserId }, items: [...grouped].map(([orderItemId, value]) => ({
          id: createId(), orderItemId, quantity: value.quantity.toString(), amount: value.amount.toFixed(4)
        })), connection });
      }
      await dao.updateReturnStatus({ tenantId, returnId, fromStatus: "INSPECTED", toStatus: "COMPLETED",
        actorUserId: context.actorUserId, notes: input.notes, connection });
      await audit(tenantId, returnId, "return.completed", { status: "INSPECTED" },
        { status: "COMPLETED", refundAmount: amount.toFixed(4) }, context, connection);
      return dao.getReturn({ tenantId, returnId, connection });
    });
  }

  async function createExchange(tenantId, returnId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await requireReturn(tenantId, returnId, connection, true);
      if (current.request.status !== "INSPECTED" || current.request.returnType !== "EXCHANGE") {
        fail("EXCHANGE_STATUS_INVALID", "An inspected clothing exchange is required.", 409);
      }
      if (current.exchanges.length) fail("EXCHANGE_ALREADY_EXISTS", "A replacement is already reserved for this return.", 409);
      const exchange = await dao.findExchangeContext({ tenantId, returnId,
        replacementOfferId: input.replacementOfferId, connection });
      if (!exchange || exchange.vertical !== "CLOTHING") {
        fail("EXCHANGE_OFFER_INVALID", "Select another size or colour from the original clothing product.", 422, "replacementOfferId");
      }
      const balance = await dao.findReplacementBalance({ tenantId, offerId: exchange.replacementOfferId,
        quantity: exchange.quantity, connection });
      if (!balance) fail("EXCHANGE_STOCK_UNAVAILABLE", "The selected replacement does not have enough available stock.", 409, "replacementOfferId");
      const id = createId();
      const priceDifference = new Decimal(exchange.replacementPrice).minus(exchange.originalPrice)
        .times(exchange.quantity).toDecimalPlaces(4).toString();
      await dao.insertExchange({ exchange: { id, tenantId, returnId, orderItemId: exchange.orderItemId,
        replacementOfferId: exchange.replacementOfferId, quantity: exchange.quantity,
        priceDifference, reservationId: createId() }, balanceId: balance.id, connection });
      await audit(tenantId, id, "exchange.created", null, { returnId, replacementOfferId: exchange.replacementOfferId,
        quantity: exchange.quantity, priceDifference }, context, connection, "EXCHANGE");
      return dao.getReturn({ tenantId, returnId, connection });
    });
  }

  async function completeExchange(tenantId, exchangeId, input, context) {
    return transaction(tenantId, async (connection) => {
      const exchange = await dao.findExchangeForUpdate({ tenantId, exchangeId, connection });
      if (!exchange || exchange.status !== "PENDING" || exchange.returnStatus !== "INSPECTED") {
        fail("EXCHANGE_NOT_FOUND", "Pending exchange was not found.", 404);
      }
      const replacementItemId = createId();
      await dao.completeExchange({ exchange: { ...exchange, tenantId }, replacementItemId,
        actorUserId: context.actorUserId, notes: input.notes, ledgerId: createId(), connection });
      await audit(tenantId, exchangeId, "exchange.completed", { status: "PENDING" },
        { status: "COMPLETED", replacementItemId }, context, connection, "EXCHANGE");
      return dao.getReturn({ tenantId, returnId: exchange.returnId, connection });
    });
  }

  return { listReturnOptions, listReturns, getReturn, createReturn, approveReturn, rejectReturn,
    receiveReturn, inspectReturn, completeReturn, createExchange, completeExchange };
}

const service = createReturnsService();
export const listReturnOptions = service.listReturnOptions;
export const listReturns = service.listReturns;
export const getReturn = service.getReturn;
export const createReturn = service.createReturn;
export const approveReturn = service.approveReturn;
export const rejectReturn = service.rejectReturn;
export const receiveReturn = service.receiveReturn;
export const inspectReturn = service.inspectReturn;
export const completeReturn = service.completeReturn;
export const createExchange = service.createExchange;
export const completeExchange = service.completeExchange;
