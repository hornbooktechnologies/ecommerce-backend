import Decimal from "decimal.js";
import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./inventory.dao.js";

function fail(code, message, status = 422, field = null) {
  throw new AppError({
    code,
    message,
    status,
    details: field ? [{ field, code: code.toLowerCase(), message }] : []
  });
}

function documentNumber(prefix, id) {
  return `${prefix}-${id.replaceAll("-", "").slice(-12).toUpperCase()}`;
}

function auditContext(context) {
  return {
    requestId: context.requestId,
    ipAddress: context.ipAddress || "127.0.0.1",
    userAgent: context.userAgent
  };
}

export function createInventoryService({ dao = defaultDao, transaction = withTransaction } = {}) {
  async function listOptions(tenantId) {
    return dao.listOptions({ tenantId });
  }

  async function listTraceabilityLots(tenantId, input) {
    const [result, summary] = await Promise.all([
      dao.listTraceabilityLots({ tenantId, ...input }),
      dao.summarizeTraceabilityLots({ tenantId })
    ]);
    return { ...result, page: input.page, pageSize: input.pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / input.pageSize)), summary };
  }

  async function listTraceabilitySerials(tenantId, input) {
    const [result, summary] = await Promise.all([
      dao.listTraceabilitySerials({ tenantId, ...input }),
      dao.summarizeTraceabilitySerials({ tenantId })
    ]);
    return { ...result, page: input.page, pageSize: input.pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / input.pageSize)), summary };
  }

  async function createWarehouse(tenantId, input, context) {
    try {
      return await transaction(tenantId, async (connection) => {
        const scope = await dao.findDefaultScope({ tenantId, connection });
        if (!scope) fail("COMMERCE_SCOPE_REQUIRED", "Create an active store and first-party merchant before adding a warehouse.", 409);

        const warehouseId = createId();
        const addressId = createId();
        await dao.insertAddress({ address: {
          id: addressId, tenantId, companyName: input.name, line1: input.line1,
          line2: input.line2, city: input.city, stateCode: input.stateCode,
          stateName: input.stateName, postalCode: input.postalCode
        }, connection });
        await dao.insertWarehouse({ warehouse: {
          id: warehouseId, tenantId, storeId: scope.storeId, merchantId: scope.merchantId,
          addressId, code: input.code, name: input.name
        }, connection });
        await dao.insertAudit({ audit: {
          id: createId(), tenantId, actorUserId: context.actorUserId,
          action: "WAREHOUSE_CREATED", entityType: "WAREHOUSE", entityId: warehouseId,
          ...auditContext(context), afterData: { code: input.code, name: input.name }
        }, connection });
        await dao.insertOutbox({ event: {
          id: createId(), tenantId, aggregateType: "WAREHOUSE", aggregateId: warehouseId,
          type: "inventory.warehouse.created", payload: { warehouseId, code: input.code }
        }, connection });
        return { id: warehouseId, code: input.code, name: input.name,
          merchantId: scope.merchantId, status: "ACTIVE" };
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        fail("WAREHOUSE_CODE_EXISTS", "A warehouse with this code already exists.", 409, "code");
      }
      throw error;
    }
  }

  async function getBalance(tenantId, balanceId) {
    const balance = await dao.findBalanceContext({ tenantId, balanceId });
    if (!balance) fail("INVENTORY_NOT_FOUND", "Inventory record was not found.", 404);
    const [lots, serials] = await Promise.all([
      balance.lotTrackingEnabled ? dao.listBalanceLots({ tenantId, balanceId }) : [],
      balance.serialTrackingEnabled ? dao.listBalanceSerials({ tenantId, balanceId }) : []
    ]);
    return { balance, lots, serials };
  }

  async function receiveStock(tenantId, input, context) {
    try {
      return await transaction(tenantId, async (connection) => {
        let purchaseOrderItem = null;
        if (input.purchaseOrderId) {
          purchaseOrderItem = await dao.findPurchaseOrderItemForReceipt({ tenantId,
            purchaseOrderId: input.purchaseOrderId, purchaseOrderItemId: input.purchaseOrderItemId, connection });
          if (!purchaseOrderItem) fail("PURCHASE_ORDER_LINE_NOT_FOUND", "Purchase order line was not found.", 404, "purchaseOrderItemId");
          if (!["APPROVED", "PARTIALLY_RECEIVED"].includes(purchaseOrderItem.status)) {
            fail("PURCHASE_ORDER_NOT_RECEIVABLE", "Approve the purchase order before receiving stock.", 409, "purchaseOrderId");
          }
          if (purchaseOrderItem.warehouseId !== input.warehouseId || purchaseOrderItem.offerId !== input.offerId) {
            fail("PURCHASE_ORDER_LINE_MISMATCH", "Warehouse and product must match the selected purchase-order line.", 422, "purchaseOrderItemId");
          }
          const remaining = new Decimal(purchaseOrderItem.orderedQuantity).minus(purchaseOrderItem.receivedQuantity);
          if (new Decimal(input.quantity).greaterThan(remaining)) {
            fail("PURCHASE_ORDER_QUANTITY_EXCEEDED", `Only ${remaining.toString()} units remain on this purchase-order line.`, 409, "quantity");
          }
        }
        const [warehouse, offer] = await Promise.all([
          dao.findWarehouse({ tenantId, warehouseId: input.warehouseId, connection }),
          dao.findOfferContext({ tenantId, offerId: input.offerId, connection })
        ]);
        if (!warehouse) fail("WAREHOUSE_NOT_FOUND", "Select an active warehouse.", 404, "warehouseId");
        if (!offer) fail("OFFER_NOT_FOUND", "Select an active product variant.", 404, "offerId");
        if (warehouse.merchantId !== offer.merchantId) {
          fail("MERCHANT_SCOPE_MISMATCH", "The selected product is not supplied by this warehouse's merchant.", 422, "offerId");
        }
        if (offer.lotTrackingEnabled && !input.lotNumber) {
          fail("LOT_NUMBER_REQUIRED", "A batch or lot number is required for this product.", 422, "lotNumber");
        }
        if (offer.expiryTrackingEnabled && !input.expiresAt) {
          fail("EXPIRY_DATE_REQUIRED", "An expiry date is required for this product.", 422, "expiresAt");
        }
        if (input.manufacturedAt && input.expiresAt && new Date(input.manufacturedAt) >= new Date(input.expiresAt)) {
          fail("INVALID_EXPIRY_DATE", "Expiry date must be later than the manufacturing date.", 422, "expiresAt");
        }
        if (offer.serialTrackingEnabled) {
          if (!Number.isInteger(input.quantity)) {
            fail("WHOLE_SERIAL_QUANTITY_REQUIRED", "Serialized products must be received in whole units.", 422, "quantity");
          }
          if (input.serialNumbers.length !== input.quantity) {
            fail("SERIAL_COUNT_MISMATCH", `Enter exactly ${input.quantity} unique serial number${input.quantity === 1 ? "" : "s"}.`, 422, "serialNumbers");
          }
        } else if (input.serialNumbers.length) {
          fail("SERIALS_NOT_SUPPORTED", "Serial numbers are only accepted for serialized products.", 422, "serialNumbers");
        }
        const unitCost = purchaseOrderItem ? purchaseOrderItem.unitCost : input.unitCost;

        let balance = await dao.findBalance({ tenantId, warehouseId: warehouse.id,
          offerId: offer.id, connection, forUpdate: true });
        if (!balance) {
          balance = { id: createId(), onHandQuantity: 0, reservedQuantity: 0, quarantineQuantity: 0 };
          await dao.insertBalance({ balance: { ...balance, tenantId,
            warehouseId: warehouse.id, offerId: offer.id }, connection });
        }

        let lotId = null;
        if (offer.lotTrackingEnabled) {
          let lot = await dao.findLot({ tenantId, balanceId: balance.id,
            lotNumber: input.lotNumber, connection, forUpdate: true });
          if (!lot) {
            lot = { id: createId() };
            await dao.insertLot({ lot: {
              id: lot.id, tenantId, balanceId: balance.id, lotNumber: input.lotNumber,
              manufacturedAt: input.manufacturedAt || null, expiresAt: input.expiresAt || null,
              quantity: input.quantity, unitCost
            }, connection });
          } else {
            await dao.updateLotQuantity({ lotId: lot.id, delta: input.quantity,
              unitCost, connection });
          }
          lotId = lot.id;
        }

        const receiptId = createId();
        const receiptNumber = documentNumber("GRN", receiptId);
        await dao.insertReceipt({ receipt: {
          id: receiptId, tenantId, number: receiptNumber, warehouseId: warehouse.id,
          purchaseOrderId: input.purchaseOrderId,
          supplierDocumentNumber: input.supplierDocumentNumber, notes: input.notes,
          userId: context.actorUserId
        }, connection });
        await dao.insertReceiptItem({ item: {
          id: createId(), receiptId, offerId: offer.id, quantity: input.quantity,
          purchaseOrderItemId: input.purchaseOrderItemId,
          lotNumber: input.lotNumber, manufacturedAt: input.manufacturedAt,
          expiresAt: input.expiresAt, unitCost,
          serialNumbers: input.serialNumbers
        }, connection });
        for (const number of input.serialNumbers) {
          await dao.insertSerial({ serial: {
            id: createId(), tenantId, balanceId: balance.id, lotId, number
          }, connection });
        }
        await dao.updateBalanceQuantity({ balanceId: balance.id, delta: input.quantity, connection });
        await dao.insertLedger({ entry: {
          id: createId(), tenantId, balanceId: balance.id, lotId,
          movementType: "GOODS_RECEIPT", delta: input.quantity, unitCost,
          referenceType: "GOODS_RECEIPT", referenceId: receiptId,
          notes: input.notes || null, userId: context.actorUserId
        }, connection });
        let purchaseOrderStatus = null;
        if (purchaseOrderItem) {
          purchaseOrderStatus = await dao.updatePurchaseOrderReceipt({ purchaseOrderId: input.purchaseOrderId,
            purchaseOrderItemId: input.purchaseOrderItemId, quantity: input.quantity, connection });
          if (!purchaseOrderStatus) fail("PURCHASE_ORDER_QUANTITY_CONFLICT", "The remaining purchase-order quantity changed. Refresh and try again.", 409, "quantity");
        }
        await dao.insertAudit({ audit: {
          id: createId(), tenantId, actorUserId: context.actorUserId,
          action: "STOCK_RECEIVED", entityType: "GOODS_RECEIPT", entityId: receiptId,
          ...auditContext(context), afterData: { receiptNumber, balanceId: balance.id,
            warehouseId: warehouse.id, offerId: offer.id, quantity: input.quantity,
            lotNumber: input.lotNumber || null, serialCount: input.serialNumbers.length,
            purchaseOrderId: input.purchaseOrderId || null, purchaseOrderItemId: input.purchaseOrderItemId || null }
        }, connection });
        await dao.insertOutbox({ event: {
          id: createId(), tenantId, aggregateType: "INVENTORY_BALANCE", aggregateId: balance.id,
          type: "inventory.stock.received", payload: { balanceId: balance.id, receiptId,
            receiptNumber, quantity: input.quantity }
        }, connection });
        return { receipt: { id: receiptId, number: receiptNumber }, balanceId: balance.id,
          purchaseOrder: purchaseOrderItem ? { id: input.purchaseOrderId,
            number: purchaseOrderItem.purchaseOrderNumber, status: purchaseOrderStatus } : null };
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        fail("SERIAL_ALREADY_RECEIVED", "One or more serial numbers already exist in this store.", 409, "serialNumbers");
      }
      throw error;
    }
  }

  async function adjustStock(tenantId, input, context) {
    return transaction(tenantId, async (connection) => {
      const balance = await dao.findBalanceContext({ tenantId, balanceId: input.balanceId,
        connection, forUpdate: true });
      if (!balance) fail("INVENTORY_NOT_FOUND", "Inventory record was not found.", 404);
      if (balance.serialTrackingEnabled) {
        fail("SERIAL_RECONCILIATION_REQUIRED", "Serialized stock must be reconciled by serial number.", 422, "countedQuantity");
      }

      let lot = null;
      if (balance.lotTrackingEnabled) {
        if (!input.lotId) fail("LOT_REQUIRED", "Select the batch being counted.", 422, "lotId");
        lot = await dao.findLot({ tenantId, balanceId: balance.id, lotId: input.lotId,
          connection, forUpdate: true });
        if (!lot) fail("LOT_NOT_FOUND", "The selected batch was not found.", 404, "lotId");
      } else if (input.lotId) {
        fail("LOT_NOT_SUPPORTED", "This product is not tracked by batch.", 422, "lotId");
      }

      const systemQuantity = new Decimal(lot ? lot.onHandQuantity : balance.onHandQuantity);
      const countedQuantity = new Decimal(input.countedQuantity);
      const delta = countedQuantity.minus(systemQuantity);
      if (delta.isZero()) fail("NO_STOCK_CHANGE", "Counted quantity is already equal to system stock.", 422, "countedQuantity");

      const committed = new Decimal(lot ? lot.reservedQuantity : balance.reservedQuantity)
        .plus(lot ? lot.quarantineQuantity : balance.quarantineQuantity);
      if (countedQuantity.lessThan(committed)) {
        fail("COUNT_BELOW_COMMITTED_STOCK",
          `Count cannot be below ${committed.toString()} units already reserved or quarantined.`, 409, "countedQuantity");
      }
      const balanceAfter = new Decimal(balance.onHandQuantity).plus(delta);
      const balanceCommitted = new Decimal(balance.reservedQuantity).plus(balance.quarantineQuantity);
      if (balanceAfter.lessThan(balanceCommitted)) {
        fail("BALANCE_BELOW_COMMITTED_STOCK",
          `This adjustment would reduce total stock below ${balanceCommitted.toString()} committed units.`, 409, "countedQuantity");
      }

      const adjustmentId = createId();
      const adjustmentNumber = documentNumber("ADJ", adjustmentId);
      const deltaValue = delta.toString();
      await dao.insertAdjustment({ adjustment: {
        id: adjustmentId, tenantId, warehouseId: balance.warehouseId,
        number: adjustmentNumber, reasonCode: input.reasonCode, notes: input.notes,
        userId: context.actorUserId
      }, connection });
      await dao.insertAdjustmentItem({ item: {
        id: createId(), adjustmentId, balanceId: balance.id, lotId: lot?.id || null,
        systemQuantity: systemQuantity.toString(), countedQuantity: countedQuantity.toString(),
        delta: deltaValue, notes: input.notes
      }, connection });
      if (lot) await dao.updateLotQuantity({ lotId: lot.id, delta: deltaValue, unitCost: null, connection });
      await dao.updateBalanceQuantity({ balanceId: balance.id, delta: deltaValue, connection });
      await dao.insertLedger({ entry: {
        id: createId(), tenantId, balanceId: balance.id, lotId: lot?.id || null,
        movementType: "STOCK_ADJUSTMENT", delta: deltaValue, unitCost: null,
        referenceType: "STOCK_ADJUSTMENT", referenceId: adjustmentId,
        reasonCode: input.reasonCode, notes: input.notes, userId: context.actorUserId
      }, connection });
      await dao.insertAudit({ audit: {
        id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "STOCK_ADJUSTED", entityType: "STOCK_ADJUSTMENT", entityId: adjustmentId,
        ...auditContext(context), afterData: { adjustmentNumber, balanceId: balance.id,
          lotId: lot?.id || null, systemQuantity: systemQuantity.toString(),
          countedQuantity: countedQuantity.toString(), delta: deltaValue, reasonCode: input.reasonCode }
      }, connection });
      await dao.insertOutbox({ event: {
        id: createId(), tenantId, aggregateType: "INVENTORY_BALANCE", aggregateId: balance.id,
        type: "inventory.stock.adjusted", payload: { balanceId: balance.id,
          adjustmentId, adjustmentNumber, delta: deltaValue }
      }, connection });
      return { adjustment: { id: adjustmentId, number: adjustmentNumber,
        delta: Number(deltaValue) }, balanceId: balance.id };
    });
  }

  async function updateStockPolicy(tenantId, balanceId, input, context) {
    return transaction(tenantId, async (connection) => {
      const balance = await dao.findBalanceContext({ tenantId, balanceId, connection, forUpdate: true });
      if (!balance) fail("INVENTORY_NOT_FOUND", "Inventory record was not found.", 404);
      await dao.updateStockPolicy({ balanceId, policy: input, connection });
      await dao.insertAudit({ audit: {
        id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "STOCK_POLICY_UPDATED", entityType: "INVENTORY_BALANCE", entityId: balanceId,
        ...auditContext(context), afterData: input
      }, connection });
      await dao.insertOutbox({ event: {
        id: createId(), tenantId, aggregateType: "INVENTORY_BALANCE", aggregateId: balanceId,
        type: "inventory.stock-policy.updated", payload: { balanceId, ...input }
      }, connection });
      return { balanceId, ...input };
    });
  }

  async function transferStock(tenantId, input, context) {
    return transaction(tenantId, async (connection) => {
      const source = await dao.findBalanceContext({ tenantId, balanceId: input.sourceBalanceId,
        connection, forUpdate: true });
      if (!source) fail("INVENTORY_NOT_FOUND", "Source inventory record was not found.", 404);
      if (source.warehouseId === input.destinationWarehouseId) {
        fail("SAME_WAREHOUSE_TRANSFER", "Choose a different destination warehouse.", 422, "destinationWarehouseId");
      }
      const destinationWarehouse = await dao.findWarehouse({ tenantId,
        warehouseId: input.destinationWarehouseId, connection });
      if (!destinationWarehouse) fail("WAREHOUSE_NOT_FOUND", "Select an active destination warehouse.", 404, "destinationWarehouseId");
      if (destinationWarehouse.merchantId !== source.merchantId) {
        fail("MERCHANT_SCOPE_MISMATCH", "Stock can only move between warehouses owned by the same merchant.", 422, "destinationWarehouseId");
      }
      const quantity = new Decimal(input.quantity);
      const serialIds = input.serialIds || [];
      let transferSerials = [];
      if (source.serialTrackingEnabled) {
        if (!serialIds.length) {
          fail("SERIAL_SELECTION_REQUIRED", "Select at least one available serial number.", 422, "serialIds");
        }
        if (!quantity.isInteger() || !quantity.equals(serialIds.length)) {
          fail("SERIAL_TRANSFER_QUANTITY_MISMATCH",
            "Transfer quantity must equal the number of selected serials.", 422, "quantity");
        }
        transferSerials = await dao.findTransferSerials({ tenantId, balanceId: source.id,
          serialIds, connection });
        if (transferSerials.length !== serialIds.length) {
          fail("SERIAL_SELECTION_INVALID",
            "One or more selected serials no longer belong to this warehouse.", 409, "serialIds");
        }
        const unavailable = transferSerials.find((serial) => serial.status !== "AVAILABLE");
        if (unavailable) {
          fail("SERIAL_NOT_AVAILABLE",
            `${unavailable.serialNumber} is ${unavailable.status.toLowerCase()} and cannot be transferred.`,
            409, "serialIds");
        }
      } else if (serialIds.length) {
        fail("SERIALS_NOT_SUPPORTED", "This stock is not tracked by serial number.", 422, "serialIds");
      }

      const sourceAvailable = new Decimal(source.onHandQuantity)
        .minus(source.reservedQuantity).minus(source.quarantineQuantity);
      if (quantity.greaterThan(sourceAvailable)) {
        fail("INSUFFICIENT_AVAILABLE_STOCK", `Only ${sourceAvailable.toString()} units are available to transfer.`, 409, "quantity");
      }

      let sourceLot = null;
      if (source.lotTrackingEnabled && !source.serialTrackingEnabled) {
        if (!input.sourceLotId) fail("LOT_REQUIRED", "Select the batch to transfer.", 422, "sourceLotId");
        sourceLot = await dao.findLot({ tenantId, balanceId: source.id, lotId: input.sourceLotId,
          connection, forUpdate: true });
        if (!sourceLot) fail("LOT_NOT_FOUND", "The selected batch was not found.", 404, "sourceLotId");
        const lotAvailable = new Decimal(sourceLot.onHandQuantity)
          .minus(sourceLot.reservedQuantity).minus(sourceLot.quarantineQuantity);
        if (quantity.greaterThan(lotAvailable)) {
          fail("INSUFFICIENT_LOT_STOCK", `Only ${lotAvailable.toString()} units are available in this batch.`, 409, "quantity");
        }
      } else if (input.sourceLotId && !source.serialTrackingEnabled) {
        fail("LOT_NOT_SUPPORTED", "This product is not tracked by batch.", 422, "sourceLotId");
      }

      let destination = await dao.findBalance({ tenantId, warehouseId: destinationWarehouse.id,
        offerId: source.offerId, connection, forUpdate: true });
      if (!destination) {
        destination = { id: createId(), onHandQuantity: 0, reservedQuantity: 0, quarantineQuantity: 0 };
        await dao.insertBalance({ balance: { ...destination, tenantId,
          warehouseId: destinationWarehouse.id, offerId: source.offerId }, connection });
      }

      let destinationLotId = null;
      const destinationLotsBySource = new Map();
      if (sourceLot) {
        let destinationLot = await dao.findLot({ tenantId, balanceId: destination.id,
          lotNumber: sourceLot.lotNumber, connection, forUpdate: true });
        if (!destinationLot) {
          destinationLot = { id: createId() };
          await dao.insertLot({ lot: {
            id: destinationLot.id, tenantId, balanceId: destination.id,
            lotNumber: sourceLot.lotNumber, manufacturedAt: sourceLot.manufacturedAt,
            expiresAt: sourceLot.expiresAt, quantity: quantity.toString(), unitCost: sourceLot.unitCost
          }, connection });
        } else {
          await dao.updateLotQuantity({ lotId: destinationLot.id, delta: quantity.toString(),
            unitCost: sourceLot.unitCost, connection });
        }
        destinationLotId = destinationLot.id;
      }

      if (transferSerials.length) {
        const serialGroups = new Map();
        for (const serial of transferSerials) {
          const key = serial.lotId || "NO_LOT";
          const group = serialGroups.get(key) || { sourceLotId: serial.lotId, serials: [], sample: serial };
          group.serials.push(serial);
          serialGroups.set(key, group);
        }
        for (const group of serialGroups.values()) {
          if (!group.sourceLotId) {
            destinationLotsBySource.set("NO_LOT", null);
            continue;
          }
          const lotQuantity = String(group.serials.length);
          const sourceUpdated = await dao.updateLotTraceability({ lotId: group.sourceLotId,
            quantityDelta: `-${lotQuantity}`, quarantineDelta: 0, connection });
          if (!sourceUpdated) fail("LOT_STOCK_CONFLICT",
            `Batch ${group.sample.lotNumber} no longer has enough available stock.`, 409, "serialIds");
          let destinationLot = await dao.findLot({ tenantId, balanceId: destination.id,
            lotNumber: group.sample.lotNumber, connection, forUpdate: true });
          if (!destinationLot) {
            destinationLot = { id: createId() };
            await dao.insertLot({ lot: { id: destinationLot.id, tenantId, balanceId: destination.id,
              lotNumber: group.sample.lotNumber, manufacturedAt: group.sample.manufacturedAt,
              expiresAt: group.sample.expiresAt, quantity: lotQuantity,
              unitCost: group.sample.unitCost }, connection });
          } else {
            await dao.updateLotQuantity({ lotId: destinationLot.id, delta: lotQuantity,
              unitCost: group.sample.unitCost, connection });
          }
          destinationLotsBySource.set(group.sourceLotId, destinationLot.id);
        }
      }

      const transferId = createId();
      const transferNumber = documentNumber("TRF", transferId);
      await dao.insertTransfer({ transfer: {
        id: transferId, tenantId, number: transferNumber,
        sourceWarehouseId: source.warehouseId,
        destinationWarehouseId: destinationWarehouse.id,
        notes: input.notes, userId: context.actorUserId
      }, connection });
      if (transferSerials.length) {
        const quantitiesByLot = new Map();
        for (const serial of transferSerials) {
          const key = serial.lotId || "NO_LOT";
          quantitiesByLot.set(key, (quantitiesByLot.get(key) || 0) + 1);
        }
        for (const [key, groupQuantity] of quantitiesByLot) {
          await dao.insertTransferItem({ item: { id: createId(), transferId,
            offerId: source.offerId, sourceLotId: key === "NO_LOT" ? null : key,
            quantity: String(groupQuantity) }, connection });
        }
      } else {
        await dao.insertTransferItem({ item: {
          id: createId(), transferId, offerId: source.offerId,
          sourceLotId: sourceLot?.id || null, quantity: quantity.toString()
        }, connection });
      }
      const negativeQuantity = quantity.negated().toString();
      if (sourceLot) await dao.updateLotQuantity({ lotId: sourceLot.id,
        delta: negativeQuantity, unitCost: null, connection });
      await dao.updateBalanceQuantity({ balanceId: source.id, delta: negativeQuantity, connection });
      await dao.updateBalanceQuantity({ balanceId: destination.id, delta: quantity.toString(), connection });
      if (transferSerials.length) {
        for (const serial of transferSerials) {
          const destinationSerialLotId = destinationLotsBySource.get(serial.lotId || "NO_LOT") || null;
          await dao.updateSerialLocation({ serialId: serial.id, balanceId: destination.id,
            lotId: destinationSerialLotId, connection });
          await dao.insertLedger({ entry: { id: createId(), tenantId, balanceId: source.id,
            lotId: serial.lotId, serialId: serial.id, movementType: "TRANSFER_OUT", delta: -1,
            unitCost: serial.unitCost, referenceType: "STOCK_TRANSFER", referenceId: transferId,
            notes: input.notes, userId: context.actorUserId }, connection });
          await dao.insertLedger({ entry: { id: createId(), tenantId, balanceId: destination.id,
            lotId: destinationSerialLotId, serialId: serial.id, movementType: "TRANSFER_IN", delta: 1,
            unitCost: serial.unitCost, referenceType: "STOCK_TRANSFER", referenceId: transferId,
            notes: input.notes, userId: context.actorUserId }, connection });
        }
      } else {
        await dao.insertLedger({ entry: {
          id: createId(), tenantId, balanceId: source.id, lotId: sourceLot?.id || null,
          movementType: "TRANSFER_OUT", delta: negativeQuantity, unitCost: sourceLot?.unitCost || null,
          referenceType: "STOCK_TRANSFER", referenceId: transferId,
          notes: input.notes, userId: context.actorUserId
        }, connection });
        await dao.insertLedger({ entry: {
          id: createId(), tenantId, balanceId: destination.id, lotId: destinationLotId,
          movementType: "TRANSFER_IN", delta: quantity.toString(), unitCost: sourceLot?.unitCost || null,
          referenceType: "STOCK_TRANSFER", referenceId: transferId,
          notes: input.notes, userId: context.actorUserId
        }, connection });
      }
      await dao.insertAudit({ audit: {
        id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "STOCK_TRANSFERRED", entityType: "STOCK_TRANSFER", entityId: transferId,
        ...auditContext(context), afterData: { transferNumber, sourceBalanceId: source.id,
          destinationBalanceId: destination.id, quantity: quantity.toString(),
          sourceLotId: sourceLot?.id || null,
          serialIds: transferSerials.map((serial) => serial.id) }
      }, connection });
      await dao.insertOutbox({ event: {
        id: createId(), tenantId, aggregateType: "STOCK_TRANSFER", aggregateId: transferId,
        type: "inventory.stock.transferred", payload: { transferId, transferNumber,
          sourceBalanceId: source.id, destinationBalanceId: destination.id,
          quantity: quantity.toString(), serialIds: transferSerials.map((serial) => serial.id) }
      }, connection });
      return { transfer: { id: transferId, number: transferNumber,
        quantity: Number(quantity.toString()), serialCount: transferSerials.length },
        destinationBalanceId: destination.id };
    });
  }

  async function reconcileSerial(tenantId, serialId, input, context) {
    return transaction(tenantId, async (connection) => {
      const serial = await dao.findSerialContext({ tenantId, serialId, connection, forUpdate: true });
      if (!serial) fail("SERIAL_NOT_FOUND", "Serial number was not found.", 404);
      if (!["AVAILABLE", "QUARANTINED"].includes(serial.status)) {
        fail("SERIAL_LIFECYCLE_LOCKED",
          `${serial.status.toLowerCase()} serials are controlled by the order lifecycle and cannot be reconciled here.`,
          409, "status");
      }
      if (serial.status === input.status) {
        fail("NO_SERIAL_STATUS_CHANGE", "Choose a different serial status.", 422, "status");
      }

      let quantityDelta = 0;
      let quarantineDelta = 0;
      if (input.status === "QUARANTINED") quarantineDelta = 1;
      if (input.status === "AVAILABLE") quarantineDelta = -1;
      if (input.status === "SCRAPPED") {
        quantityDelta = -1;
        quarantineDelta = serial.status === "QUARANTINED" ? -1 : 0;
      }

      if (serial.lotId) {
        const lotUpdated = await dao.updateLotTraceability({ lotId: serial.lotId,
          quantityDelta, quarantineDelta, connection });
        if (!lotUpdated) fail("LOT_STOCK_CONFLICT",
          "The batch quantities changed while this serial was being reconciled. Refresh and try again.", 409);
      }
      const balanceUpdated = await dao.updateBalanceTraceability({ balanceId: serial.balanceId,
        quantityDelta, quarantineDelta, connection });
      if (!balanceUpdated) fail("INVENTORY_STOCK_CONFLICT",
        "The warehouse quantities changed while this serial was being reconciled. Refresh and try again.", 409);

      let referenceType = "SERIAL_RECONCILIATION";
      let referenceId = serial.id;
      let adjustment = null;
      if (input.status === "SCRAPPED") {
        const adjustmentId = createId();
        const adjustmentNumber = documentNumber("ADJ", adjustmentId);
        await dao.insertAdjustment({ adjustment: {
          id: adjustmentId, tenantId, warehouseId: serial.warehouseId,
          number: adjustmentNumber, reasonCode: input.reasonCode,
          notes: input.notes, userId: context.actorUserId
        }, connection });
        await dao.insertAdjustmentItem({ item: {
          id: createId(), adjustmentId, balanceId: serial.balanceId, lotId: serial.lotId,
          serialId: serial.id, systemQuantity: 1, countedQuantity: 0, delta: -1,
          notes: input.notes
        }, connection });
        referenceType = "STOCK_ADJUSTMENT";
        referenceId = adjustmentId;
        adjustment = { id: adjustmentId, number: adjustmentNumber };
      }

      await dao.updateSerialStatus({ serialId: serial.id, status: input.status, connection });
      const movementType = input.status === "QUARANTINED"
        ? "SERIAL_QUARANTINED"
        : input.status === "AVAILABLE" ? "SERIAL_RELEASED" : "SERIAL_SCRAPPED";
      await dao.insertLedger({ entry: {
        id: createId(), tenantId, balanceId: serial.balanceId, lotId: serial.lotId,
        serialId: serial.id, movementType, delta: quantityDelta,
        quarantineDelta, unitCost: null, referenceType, referenceId,
        reasonCode: input.reasonCode, notes: input.notes, userId: context.actorUserId
      }, connection });
      await dao.insertAudit({ audit: {
        id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "SERIAL_RECONCILED", entityType: "SERIAL_NUMBER", entityId: serial.id,
        ...auditContext(context), afterData: { serialNumber: serial.serialNumber,
          previousStatus: serial.status, status: input.status, reasonCode: input.reasonCode,
          balanceId: serial.balanceId, lotId: serial.lotId, quantityDelta, quarantineDelta }
      }, connection });
      await dao.insertOutbox({ event: {
        id: createId(), tenantId, aggregateType: "SERIAL_NUMBER", aggregateId: serial.id,
        type: "inventory.serial.reconciled", payload: { serialId: serial.id,
          serialNumber: serial.serialNumber, previousStatus: serial.status,
          status: input.status, balanceId: serial.balanceId }
      }, connection });
      return { serial: { id: serial.id, serialNumber: serial.serialNumber,
        previousStatus: serial.status, status: input.status }, adjustment };
    });
  }

  return { listOptions, listTraceabilityLots, listTraceabilitySerials, createWarehouse,
    getBalance, receiveStock, adjustStock, updateStockPolicy, transferStock, reconcileSerial };
}

const inventoryService = createInventoryService();
export const { listOptions, listTraceabilityLots, listTraceabilitySerials, createWarehouse,
  getBalance, receiveStock, adjustStock, updateStockPolicy, transferStock,
  reconcileSerial } = inventoryService;
