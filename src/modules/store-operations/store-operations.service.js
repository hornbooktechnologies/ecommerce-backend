import { AppError } from "../../core/errors/app-error.js";
import { createId } from "../../core/identifiers/uuid.js";
import { withTransaction } from "../../database/transaction.js";
import * as defaultDao from "./store-operations.dao.js";

function fail(code, message, status = 422, field = null) {
  throw new AppError({ code, message, status, details: field ? [{ field, code: code.toLowerCase(), message }] : [] });
}

function auditContext(context) {
  return { requestId: context.requestId, ipAddress: context.ipAddress || "127.0.0.1", userAgent: context.userAgent };
}

function indiaDateTime(day, time) {
  return new Date(`${day}T${String(time).slice(0, 8)}+05:30`);
}

function nextDate(offset) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date;
}

function dayString(date) { return date.toISOString().slice(0, 10); }

export function createStoreOperationsService({ dao = defaultDao, transaction = withTransaction } = {}) {
  async function listStores(tenantId, filters) {
    const [result, summary] = await Promise.all([
      dao.listStores({ tenantId, ...filters }), dao.summarizeStores({ tenantId })
    ]);
    return { ...result, summary };
  }

  async function getStore(tenantId, storeId) {
    const store = await dao.findStore({ tenantId, storeId });
    if (!store) fail("STORE_NOT_FOUND", "Store was not found.", 404);
    const [zones, templates, instances, warehouses] = await Promise.all([
      dao.listZones({ tenantId, storeId }), dao.listTemplates({ tenantId, storeId }),
      dao.listUpcomingInstances({ tenantId, storeId, days: store.slotHorizonDays }),
      dao.listWarehouses({ tenantId, storeId })
    ]);
    return { store, zones, templates, instances, warehouses };
  }

  async function createStore(tenantId, input, context) {
    try {
      const storeId = await transaction(tenantId, async (connection) => {
        const merchantId = await dao.findFirstPartyMerchant({ tenantId, connection });
        if (!merchantId) fail("FIRST_PARTY_MERCHANT_REQUIRED", "Create the tenant retail scope before adding another store.", 409);
        const addressId = createId();
        const id = createId();
        await dao.insertAddress({ address: { id: addressId, tenantId, companyName: input.name, ...input }, connection });
        await dao.insertStore({ store: { id, tenantId, addressId, ...input }, connection });
        await dao.insertStoreMerchant({ storeId: id, merchantId, connection });
        await dao.insertAdminChannel({ id: createId(), tenantId, storeId: id, connection });
        await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
          action: "STORE_CREATED", entityType: "STORE", entityId: id, ...auditContext(context),
          afterData: { code: input.code, name: input.name, status: input.status } }, connection });
        return id;
      });
      return getStore(tenantId, storeId);
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") fail("STORE_CODE_EXISTS", "A store with this code already exists.", 409, "code");
      throw error;
    }
  }

  async function updateStore(tenantId, storeId, input, context) {
    await transaction(tenantId, async (connection) => {
      const current = await dao.findStore({ tenantId, storeId, connection, forUpdate: true });
      if (!current) fail("STORE_NOT_FOUND", "Store was not found.", 404);
      await dao.updateStore({ storeId, input, connection });
      await dao.updateAddress({ addressId: current.addressId, input, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "STORE_UPDATED", entityType: "STORE", entityId: storeId, ...auditContext(context),
        afterData: { name: input.name, status: input.status, substitutionPolicy: input.substitutionPolicy,
          slotHorizonDays: input.slotHorizonDays } }, connection });
    });
    return getStore(tenantId, storeId);
  }

  async function saveZone(tenantId, storeId, zoneId, input, context) {
    const creating = !zoneId;
    const savedId = await transaction(tenantId, async (connection) => {
      const store = await dao.findStore({ tenantId, storeId, connection });
      if (!store) fail("STORE_NOT_FOUND", "Store was not found.", 404);
      if (zoneId) {
        const zone = await dao.findZone({ tenantId, storeId, zoneId, connection, forUpdate: true });
        if (!zone) fail("DELIVERY_ZONE_NOT_FOUND", "Delivery zone was not found.", 404);
        await dao.updateZone({ zoneId, input, connection });
      } else {
        zoneId = createId();
        await dao.insertZone({ zone: { id: zoneId, tenantId, storeId, ...input }, connection });
      }
      await dao.replaceZonePostalCodes({ zoneId, postalCodes: input.postalCodes, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: creating ? "DELIVERY_ZONE_CREATED" : "DELIVERY_ZONE_UPDATED", entityType: "DELIVERY_ZONE",
        entityId: zoneId, ...auditContext(context), afterData: { name: input.name, status: input.status,
          postalCodes: input.postalCodes } }, connection });
      return zoneId;
    });
    const details = await getStore(tenantId, storeId);
    return details.zones.find((zone) => zone.id === savedId);
  }

  async function saveTemplate(tenantId, storeId, templateId, input, context) {
    const savedId = await transaction(tenantId, async (connection) => {
      const zone = await dao.findZone({ tenantId, storeId, zoneId: input.zoneId, connection });
      if (!zone) fail("DELIVERY_ZONE_NOT_FOUND", "Select a delivery zone belonging to this store.", 404, "zoneId");
      if (templateId) {
        const template = await dao.findTemplate({ tenantId, storeId, templateId, connection, forUpdate: true });
        if (!template) fail("SLOT_TEMPLATE_NOT_FOUND", "Delivery slot schedule was not found.", 404);
        await dao.updateTemplate({ templateId, input, connection });
      } else {
        templateId = createId();
        await dao.insertTemplate({ template: { id: templateId, tenantId, ...input }, connection });
      }
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "DELIVERY_SLOT_TEMPLATE_SAVED", entityType: "DELIVERY_SLOT_TEMPLATE", entityId: templateId,
        ...auditContext(context), afterData: { name: input.name, zoneId: input.zoneId,
          dayOfWeek: input.dayOfWeek, startTime: input.startTime, endTime: input.endTime } }, connection });
      return templateId;
    });
    const details = await getStore(tenantId, storeId);
    return details.templates.find((template) => template.id === savedId);
  }

  async function generateSlots(tenantId, storeId, input, context) {
    const created = await transaction(tenantId, async (connection) => {
      const store = await dao.findStore({ tenantId, storeId, connection });
      if (!store) fail("STORE_NOT_FOUND", "Store was not found.", 404);
      const templates = await dao.listActiveTemplates({ tenantId, storeId, connection });
      if (!templates.length) fail("SLOT_TEMPLATE_REQUIRED", "Add at least one active weekly slot before generating capacity.", 409);
      let count = 0;
      for (let offset = 0; offset < input.days; offset += 1) {
        const date = nextDate(offset);
        const dateValue = dayString(date);
        for (const template of templates.filter((item) => item.dayOfWeek === date.getUTCDay())) {
          count += await dao.insertSlotInstance({ instance: { id: createId(), tenantId,
            templateId: template.id, zoneId: template.zoneId, slotDate: dateValue,
            startsAt: indiaDateTime(dateValue, template.startTime), endsAt: indiaDateTime(dateValue, template.endTime),
            orderCapacity: template.orderCapacity, weightCapacity: template.weightCapacity }, connection });
        }
      }
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "DELIVERY_SLOTS_GENERATED", entityType: "STORE", entityId: storeId, ...auditContext(context),
        afterData: { requestedDays: input.days, createdInstances: count } }, connection });
      return count;
    });
    return { created, instances: await dao.listUpcomingInstances({ tenantId, storeId, days: input.days }) };
  }

  async function assignWarehouses(tenantId, storeId, input, context) {
    await transaction(tenantId, async (connection) => {
      const store = await dao.findStore({ tenantId, storeId, connection });
      if (!store) fail("STORE_NOT_FOUND", "Store was not found.", 404);
      const warehouses = await dao.listWarehouses({ tenantId, storeId, connection });
      const eligible = new Set(warehouses.map((warehouse) => warehouse.id));
      if (input.warehouseIds.some((id) => !eligible.has(id))) {
        fail("WAREHOUSE_NOT_ELIGIBLE", "One or more warehouses do not belong to this retail tenant.", 422, "warehouseIds");
      }
      await dao.assignWarehouses({ tenantId, storeId, warehouseIds: input.warehouseIds, connection });
      await dao.insertAudit({ audit: { id: createId(), tenantId, actorUserId: context.actorUserId,
        action: "STORE_WAREHOUSES_ASSIGNED", entityType: "STORE", entityId: storeId, ...auditContext(context),
        afterData: { warehouseIds: input.warehouseIds } }, connection });
    });
    return { warehouses: await dao.listWarehouses({ tenantId, storeId }) };
  }

  return { listStores, getStore, createStore, updateStore,
    createZone: (tenantId, storeId, input, context) => saveZone(tenantId, storeId, null, input, context),
    updateZone: (tenantId, storeId, zoneId, input, context) => saveZone(tenantId, storeId, zoneId, input, context),
    createTemplate: (tenantId, storeId, input, context) => saveTemplate(tenantId, storeId, null, input, context),
    updateTemplate: (tenantId, storeId, templateId, input, context) => saveTemplate(tenantId, storeId, templateId, input, context),
    generateSlots, assignWarehouses };
}

const service = createStoreOperationsService();
export const { listStores, getStore, createStore, updateStore, createZone, updateZone,
  createTemplate, updateTemplate, generateSlots, assignWarehouses } = service;
