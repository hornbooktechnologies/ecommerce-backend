import Decimal from "decimal.js";
import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./procurement.dao.js";

function fail(code, message, status = 422, field = null) {
  throw new AppError({ code, message, status,
    details: field ? [{ field, code: code.toLowerCase(), message }] : [] });
}
const number = (prefix, id) => `${prefix}-${id.replaceAll("-", "").slice(-12).toUpperCase()}`;
const auditActor = (context) => ({ actorUserId: context.actorUserId, requestId: context.requestId,
  ipAddress: context.ipAddress || "127.0.0.1", userAgent: context.userAgent?.slice(0, 500) || null });

export function createProcurementService({ dao = defaultDao, transaction = withTransaction } = {}) {
  const listSuppliers = (tenantId, filters) => dao.listSuppliers({ tenantId, filters });
  const listPurchaseOrders = (tenantId, filters) => dao.listPurchaseOrders({ tenantId, filters });
  const listOptions = (tenantId) => dao.listOptions({ tenantId });

  async function getPurchaseOrder(tenantId, purchaseOrderId) {
    const order = await dao.findPurchaseOrder({ tenantId, purchaseOrderId });
    if (!order) fail("PURCHASE_ORDER_NOT_FOUND", "Purchase order was not found.", 404);
    return order;
  }

  async function saveSupplier(tenantId, supplierId, input, context) {
    try {
      return await transaction(tenantId, async (connection) => {
        const current = supplierId ? await dao.findSupplier({ tenantId, supplierId, connection, forUpdate: true }) : null;
        if (supplierId && !current) fail("SUPPLIER_NOT_FOUND", "Supplier was not found.", 404);
        const id = supplierId || createId();
        if (supplierId) await dao.updateSupplier({ supplierId, input, connection });
        else await dao.insertSupplier({ supplier: { id, tenantId, ...input }, connection });
        await dao.insertAudit({ audit: { id: createId(), tenantId, entityId: id,
          action: supplierId ? "supplier.updated" : "supplier.created", entityType: "SUPPLIER",
          ...auditActor(context), beforeData: current, afterData: { code: input.code,
            displayName: input.displayName, status: input.status } }, connection });
        return dao.findSupplier({ tenantId, supplierId: id, connection });
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") fail("SUPPLIER_CODE_EXISTS", "This supplier code is already in use.", 409, "code");
      throw error;
    }
  }

  async function createPurchaseOrder(tenantId, input, context) {
    return transaction(tenantId, async (connection) => {
      const offerIds = input.items.map((item) => item.offerId);
      const scope = await dao.findOrderScope({ tenantId, supplierId: input.supplierId,
        warehouseId: input.warehouseId, offerIds, connection });
      if (!scope) fail("PROCUREMENT_SCOPE_INVALID", "Select an active supplier and warehouse.", 422);
      if (scope.validOfferIds.length !== new Set(offerIds).size) {
        fail("PROCUREMENT_OFFER_INVALID", "Every product must belong to the warehouse merchant and have an active offer.", 422, "items");
      }
      const lines = input.items.map((item) => {
        const base = new Decimal(item.quantity).times(item.unitCost);
        const tax = base.times(item.taxRate).dividedBy(100).toDecimalPlaces(4);
        return { ...item, taxAmount: tax.toNumber(), lineTotal: base.plus(tax).toNumber() };
      });
      const subtotal = lines.reduce((sum, line) => sum.plus(new Decimal(line.quantity).times(line.unitCost)), new Decimal(0));
      const taxTotal = lines.reduce((sum, line) => sum.plus(line.taxAmount), new Decimal(0));
      const id = createId(); const orderNumber = number("PO", id);
      await dao.insertPurchaseOrder({ order: { id, tenantId, number: orderNumber,
        ...input, subtotal: subtotal.toNumber(), taxTotal: taxTotal.toNumber(),
        grandTotal: subtotal.plus(taxTotal).toNumber(), actorUserId: context.actorUserId }, connection });
      for (const line of lines) await dao.insertPurchaseOrderItem({ item: {
        id: createId(), purchaseOrderId: id, ...line }, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, entityId: id,
        action: "purchase_order.created", entityType: "PURCHASE_ORDER", ...auditActor(context),
        beforeData: null, afterData: { orderNumber, supplierId: input.supplierId,
          warehouseId: input.warehouseId, itemCount: lines.length, grandTotal: subtotal.plus(taxTotal).toNumber() } }, connection });
      await dao.insertOutbox({ event: { id: createId(), tenantId, aggregateType: "PURCHASE_ORDER",
        aggregateId: id, type: "procurement.purchase-order.created", payload: { purchaseOrderId: id, orderNumber } }, connection });
      return dao.findPurchaseOrder({ tenantId, purchaseOrderId: id, connection });
    });
  }

  async function transitionPurchaseOrder(tenantId, purchaseOrderId, action, context) {
    return transaction(tenantId, async (connection) => {
      const current = await dao.findPurchaseOrder({ tenantId, purchaseOrderId, connection, forUpdate: true });
      if (!current) fail("PURCHASE_ORDER_NOT_FOUND", "Purchase order was not found.", 404);
      if (action === "approve" && current.status !== "DRAFT") {
        fail("PURCHASE_ORDER_NOT_DRAFT", "Only draft purchase orders can be approved.", 409);
      }
      if (action === "cancel" && !["DRAFT", "APPROVED"].includes(current.status)) {
        fail("PURCHASE_ORDER_CANNOT_CANCEL", "Only unreceived draft or approved orders can be cancelled.", 409);
      }
      await dao.transitionPurchaseOrder({ purchaseOrderId, action, actorUserId: context.actorUserId, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, entityId: purchaseOrderId,
        action: `purchase_order.${action}d`, entityType: "PURCHASE_ORDER", ...auditActor(context),
        beforeData: { status: current.status }, afterData: { status: action === "approve" ? "APPROVED" : "CANCELLED" } }, connection });
      await dao.insertOutbox({ event: { id: createId(), tenantId, aggregateType: "PURCHASE_ORDER",
        aggregateId: purchaseOrderId, type: `procurement.purchase-order.${action}d`,
        payload: { purchaseOrderId, number: current.number } }, connection });
      return dao.findPurchaseOrder({ tenantId, purchaseOrderId, connection });
    });
  }

  return { listSuppliers, createSupplier: (tenantId, input, context) => saveSupplier(tenantId, null, input, context),
    updateSupplier: (tenantId, supplierId, input, context) => saveSupplier(tenantId, supplierId, input, context),
    listOptions, listPurchaseOrders, getPurchaseOrder, createPurchaseOrder,
    approvePurchaseOrder: (tenantId, id, context) => transitionPurchaseOrder(tenantId, id, "approve", context),
    cancelPurchaseOrder: (tenantId, id, context) => transitionPurchaseOrder(tenantId, id, "cancel", context) };
}

const service = createProcurementService();
export const { listSuppliers, createSupplier, updateSupplier, listOptions, listPurchaseOrders,
  getPurchaseOrder, createPurchaseOrder, approvePurchaseOrder, cancelPurchaseOrder } = service;
