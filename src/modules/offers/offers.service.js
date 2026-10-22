import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./offers.dao.js";

function fail(code, message, status = 422, field = null) {
  throw new AppError({ code, message, status,
    details: field ? [{ field, code: code.toLowerCase(), message }] : [] });
}

function actor(context) {
  return { actorUserId: context.actorUserId, requestId: context.requestId,
    ipAddress: context.ipAddress || null, userAgent: context.userAgent?.slice(0, 500) || null };
}

function normalizeNullable(value) { return value === "" || value === undefined ? null : value; }

export function createOffersService({ dao = defaultDao, transaction = withTransaction } = {}) {
  const listOffers = (tenantId, filters) => dao.listOffers({ tenantId, filters });
  const listOptions = (tenantId, filters) => dao.listOptions({ tenantId, variantSearch: filters.variantSearch });
  const listPriceLists = (tenantId) => dao.listPriceLists({ tenantId });

  async function getOffer(tenantId, offerId) {
    const offer = await dao.getOffer({ tenantId, offerId });
    if (!offer) fail("OFFER_NOT_FOUND", "Seller offer was not found.", 404);
    return offer;
  }

  async function audit(tenantId, entityId, action, entityType, beforeData, afterData, context, connection) {
    await dao.insertAudit({ audit: { id: createId(), tenantId, entityId, action, entityType,
      ...actor(context), beforeData, afterData }, connection });
  }

  async function validateScope(tenantId, input, connection, { requireActiveMerchant = true } = {}) {
    const scope = await dao.findOfferContext({ tenantId, merchantId: input.merchantId, storeId: input.storeId,
      variantId: input.variantId, priceListId: input.priceListId, connection });
    if (!scope) fail("OFFER_SCOPE_INVALID", "Select an active merchant, assigned store, catalog variant, and INR price list.", 422);
    if (requireActiveMerchant && scope.merchantStatus !== "ACTIVE") fail("MERCHANT_INACTIVE", "Activate the merchant before publishing offers.", 409, "merchantId");
    if (scope.priceListStatus !== "ACTIVE") fail("PRICE_LIST_INACTIVE", "Select an active price list.", 409, "priceListId");
    if (scope.priceListStoreId && scope.priceListStoreId !== input.storeId) {
      fail("PRICE_LIST_SCOPE_INVALID", "The selected price list belongs to another store.", 422, "priceListId");
    }
    return scope;
  }

  async function createOffer(tenantId, input, context) {
    return transaction(tenantId, async (connection) => {
      if (input.salePrice > input.listPrice) {
        fail("OFFER_PRICE_INVALID", "Selling price cannot exceed MRP.", 422, "salePrice");
      }
      const scope = await validateScope(tenantId, input, connection);
      if (await dao.findDuplicateOffer({ storeId: input.storeId, merchantId: input.merchantId,
        variantId: input.variantId, sellerSku: input.sellerSku, connection })) {
        fail("OFFER_EXISTS", "This variant or seller SKU already has an offer for the merchant and store.", 409, "variantId");
      }
      const offerId = createId();
      await dao.insertOffer({ offer: { id: offerId, tenantId, ...input,
        minimumOrderQuantity: normalizeNullable(input.minimumOrderQuantity),
        maximumOrderQuantity: normalizeNullable(input.maximumOrderQuantity),
        taxCategoryId: scope.taxCategoryId, actorUserId: context.actorUserId }, connection });
      await dao.insertOfferPrice({ price: { id: createId(), tenantId, offerId, priceListId: input.priceListId,
        listPrice: input.listPrice, salePrice: input.salePrice, costPrice: normalizeNullable(input.costPrice) }, connection });
      await audit(tenantId, offerId, "seller_offer.created", "SELLER_OFFER", null,
        { merchantId: input.merchantId, storeId: input.storeId, variantId: input.variantId,
          status: input.status, salePrice: input.salePrice }, context, connection);
      return dao.getOffer({ tenantId, offerId, connection });
    });
  }

  async function updateOffer(tenantId, offerId, input, context) {
    return transaction(tenantId, async (connection) => {
      const current = await dao.getOffer({ tenantId, offerId, connection, forUpdate: true });
      if (!current) fail("OFFER_NOT_FOUND", "Seller offer was not found.", 404);
      if (input.status === "ACTIVE" && current.merchantStatus !== "ACTIVE") {
        fail("MERCHANT_INACTIVE", "Restore the merchant before activating this seller offer.", 409, "status");
      }
      const listPrice = input.listPrice ?? current.listPrice;
      const salePrice = input.salePrice ?? current.salePrice;
      const costPrice = input.costPrice !== undefined ? normalizeNullable(input.costPrice) : current.costPrice;
      const priceListId = input.priceListId || current.priceListId;
      if (!priceListId || listPrice === null || salePrice === null) {
        fail("OFFER_PRICE_MISSING", "Select a price list and enter MRP and selling price.", 409);
      }
      if (salePrice > listPrice) fail("OFFER_PRICE_INVALID", "Selling price cannot exceed MRP.", 422, "salePrice");
      const minimum = input.minimumOrderQuantity !== undefined ? normalizeNullable(input.minimumOrderQuantity) : current.minimumOrderQuantity;
      const maximum = input.maximumOrderQuantity !== undefined ? normalizeNullable(input.maximumOrderQuantity) : current.maximumOrderQuantity;
      if (minimum && maximum && maximum < minimum) {
        fail("OFFER_QUANTITY_INVALID", "Maximum order quantity must be greater than or equal to the minimum.", 422, "maximumOrderQuantity");
      }
      if (input.priceListId) {
        await validateScope(tenantId, { merchantId: current.merchantId, storeId: current.storeId,
          variantId: current.variantId, priceListId }, connection, { requireActiveMerchant: false });
      }
      await dao.updateOffer({ offerId, changes: { ...input, minimumOrderQuantity: minimum,
        maximumOrderQuantity: maximum }, actorUserId: context.actorUserId, connection });
      const priceChanged = input.priceListId !== undefined || input.listPrice !== undefined
        || input.salePrice !== undefined || input.costPrice !== undefined;
      if (priceChanged) {
        await dao.closeOfferPrices({ offerId, connection });
        await dao.insertOfferPrice({ price: { id: createId(), tenantId, offerId, priceListId,
          listPrice, salePrice, costPrice }, connection });
      }
      await audit(tenantId, offerId, "seller_offer.updated", "SELLER_OFFER",
        { status: current.status, listPrice: current.listPrice, salePrice: current.salePrice },
        { changedFields: Object.keys(input), status: input.status || current.status, listPrice, salePrice }, context, connection);
      return dao.getOffer({ tenantId, offerId, connection });
    });
  }

  async function savePriceList(tenantId, priceListId, input, context) {
    try {
      return await transaction(tenantId, async (connection) => {
        if (!await dao.storeExists({ tenantId, storeId: input.storeId, connection })) {
          fail("STORE_NOT_FOUND", "Select an active store in this workspace.", 422, "storeId");
        }
        let beforeData = null; const id = priceListId || createId();
        if (priceListId) {
          beforeData = await dao.findPriceList({ tenantId, priceListId, connection, forUpdate: true });
          if (!beforeData) fail("PRICE_LIST_NOT_FOUND", "Price list was not found.", 404);
          await dao.updatePriceList({ priceListId, input, connection });
        } else {
          await dao.insertPriceList({ priceList: { id, tenantId, ...input }, connection });
        }
        await audit(tenantId, id, priceListId ? "price_list.updated" : "price_list.created", "PRICE_LIST",
          beforeData, { code: input.code, name: input.name, status: input.status }, context, connection);
        return dao.findPriceList({ tenantId, priceListId: id, connection });
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") fail("PRICE_LIST_CODE_EXISTS", "This price list code is already in use.", 409, "code");
      throw error;
    }
  }

  return { listOffers, listOptions, getOffer, createOffer, updateOffer, listPriceLists,
    createPriceList: (tenantId, input, context) => savePriceList(tenantId, null, input, context),
    updatePriceList: (tenantId, priceListId, input, context) => savePriceList(tenantId, priceListId, input, context) };
}

const service = createOffersService();
export const { listOffers, listOptions, getOffer, createOffer, updateOffer, listPriceLists,
  createPriceList, updatePriceList } = service;
