import Decimal from "decimal.js";
import { createHash } from "node:crypto";
import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import * as defaultDao from "./customer-after-sales.dao.js";
import * as defaultOrderDao from "../orders/orders.dao.js";
import * as defaultReturnDao from "../returns/returns.dao.js";
import { createOrdersService } from "../orders/orders.service.js";
import { createReturnsService } from "../returns/returns.service.js";

const fail = (code, message, status = 409, field) => { throw new AppError({ code, message, status, details: field ? [{ field, message }] : [] }); };
const cancellable = new Set(["PLACED", "CONFIRMED", "PROCESSING"]);

// Called only inside the authenticated account transaction. Never opens or
// commits a second transaction: stock, slots, request receipt and audit are atomic.
export function createCustomerAfterSalesService({ dao = defaultDao, orderDao = defaultOrderDao,
  returnDao = defaultReturnDao, orderFactory = createOrdersService, returnFactory = createReturnsService } = {}) {
  async function requireOrder(args) {
    const order = await dao.ownedOrder(args);
    if (!order) fail("CUSTOMER_ORDER_NOT_FOUND", "This order is unavailable in your account.", 404);
    return order;
  }
  async function read(args) {
    const order = await requireOrder(args);
    const items = await dao.items(args);
    const cases = await dao.cases(args);
    const serials = await dao.serials(args);
    const reserved = new Set(cases.filter((entry) => entry.status !== "REJECTED").flatMap((entry) => entry.items.map((item) => item.serialId)).filter(Boolean));
    const dispatched = await orderDao.hasDispatchedFulfillment(args);
    return { canCancel: cancellable.has(order.status) && !dispatched,
      cancellationMessage: order.status === "CANCELLED" ? "This order is cancelled. Any payment already collected needs separate refund review."
        : dispatched ? "An item has been dispatched. Cancellation is no longer available; check returns after delivery."
          : !cancellable.has(order.status) ? "Cancellation is unavailable for this order status. Contact the store for help."
            : "Cancellation applies to the whole order. It does not automatically refund a payment.",
      cases: cases.map((entry) => ({ ...entry, items: entry.items.map((item) => ({ orderItemId: item.orderItemId, name: item.name, quantity: item.quantity })) })),
      items: items.map((item) => {
        const requested = cases.filter((entry) => entry.status !== "REJECTED").flatMap((entry) => entry.items)
          .filter((line) => line.orderItemId === item.id).reduce((sum, line) => sum.plus(line.quantity), new Decimal(0));
        const remaining = Decimal.max(0, new Decimal(item.quantity).minus(requested)).toNumber();
        const expiresAt = item.deliveredAt && item.windowDays > 0 ? new Date(new Date(item.deliveredAt).getTime() + item.windowDays * 86400000).toISOString() : null;
        const reason = order.status === "CANCELLED" ? "This order is cancelled."
          : item.status !== "FULFILLED" || !item.deliveredAt ? "Available after this item's delivery is completed."
            : !item.returnable ? "This product is not returnable. Contact the store for help."
              : !expiresAt ? "Online returns are not configured for this product. Contact the store."
                : new Date(item.checkedAt) > new Date(expiresAt) ? "The configured return window has ended. Contact the store for help."
                  : remaining <= 0 ? "All eligible units already have a return or exchange request." : "";
        return { id: item.id, name: item.name, variant: item.variant, remaining, eligible: !reason, reason,
          canExchange: !reason && item.vertical === "CLOTHING", fractional: item.fractional, expiresAt,
          serials: serials.filter((serial) => serial.orderItemId === item.id && !reserved.has(serial.id)).map(({ id, number }) => ({ id, number })) };
      }) };
  }
  function auditFor(args, entityType) {
    return ({ audit }) => dao.audit({ ...args, entityType, entityId: audit.entityId || audit.orderId,
      action: audit.action, afterData: audit.afterData });
  }
  async function cancel(args, input) {
    args = { ...args, lock: true };
    const order = await requireOrder(args);
    if (order.status === "CANCELLED") return { message: "This order is already cancelled." };
    if (!cancellable.has(order.status)) fail("CUSTOMER_CANCELLATION_UNAVAILABLE", "This order cannot be cancelled. Contact the store for help.");
    const orders = orderFactory({ dao: { ...orderDao, insertAudit: auditFor(args, "CUSTOMER_ORDER") },
      transaction: async (_tenant, operation) => operation(args.connection) });
    // The shared transition rechecks dispatch while the owned order is locked.
    await orders.transitionOrder(args.tenantId, args.orderId,
      { status: "CANCELLED", reasonCode: "CUSTOMER_REQUEST", notes: input.reason }, { actorUserId: null });
    return { message: "Order cancelled. Any payment already collected requires separate refund review." };
  }
  async function requestReturn(args, input) {
    args = { ...args, lock: true };
    await requireOrder(args);
    const key = `${args.customerId}:${args.storeId}:${input.requestId}`;
    const normalized = { orderId: args.orderId, orderItemId: input.orderItemId, returnType: input.returnType,
      quantity: input.quantity, reasonCode: input.reasonCode, customerComments: input.customerComments, serialIds: [...input.serialIds].sort() };
    const hash = createHash("sha256").update(JSON.stringify(normalized)).digest();
    const previous = await dao.receipt({ ...args, key });
    if (previous) {
      if (!previous.hash.equals(hash)) fail("RETURN_REQUEST_CHANGED", "This submission was already used with different details. Refresh and try again.");
      return previous.body;
    }
    const options = await read(args);
    const item = options.items.find((entry) => entry.id === input.orderItemId);
    if (!item) fail("CUSTOMER_ORDER_ITEM_NOT_FOUND", "This item is unavailable in your account.", 404);
    if (!item.eligible) fail("RETURN_ITEM_INELIGIBLE", item.reason, 409, "orderItemId");
    if (input.quantity > item.remaining || (!item.fractional && !Number.isInteger(input.quantity))) fail("RETURN_QUANTITY_INVALID", `Enter an eligible quantity up to ${item.remaining}.`, 422, "quantity");
    if (input.returnType === "EXCHANGE" && !item.canExchange) fail("EXCHANGE_REQUIRES_CLOTHING", "Only clothing items support size or colour exchanges.", 422, "returnType");
    if (input.serialIds.some((id) => !item.serials.some((serial) => serial.id === id))) fail("RETURN_SERIAL_INVALID", "A selected serial is unavailable or already included in another request.", 409, "serialIds");
    const returns = returnFactory({ dao: { ...returnDao, insertAudit: auditFor(args, "RETURN_REQUEST") },
      transaction: async (_tenant, operation) => operation(args.connection) });
    const result = await returns.createReturn(args.tenantId, input, { actorUserId: null });
    const body = { id: result.request.id, number: result.request.returnNumber,
      message: "Request received. The store will review it before arranging a return, replacement or refund." };
    await dao.saveReceipt({ ...args, receiptId: createId(), key, hash, body });
    return body;
  }
  return { read, cancel, requestReturn };
}
