import Decimal from "decimal.js";
import { createId } from "../../core/identifiers/uuid.js";
import { getPrimaryPool } from "../../database/pool-factory.js";
import * as defaultDao from "./stock-alerts.dao.js";
import * as defaultInbox from "./inbox.dao.js";

const label = value => String(value || "Not specified").replaceAll(/[\r\n\t]/g, " ").slice(0, 120);

export function createStockAlertMonitor({ dao = defaultDao, inbox = defaultInbox, pool = getPrimaryPool() } = {}) {
  let cursor = null;
  async function observe(scope) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const args = { ...scope, connection };
      const balance = await dao.lockBalance(args);
      if (!balance) { await connection.commit(); return false; }
      const previous = await dao.state(args);
      const source = await dao.source(args);
      const available = new Decimal(balance.onHand).minus(balance.reserved).minus(balance.quarantine);
      const low = source && balance.threshold !== null && available.lte(balance.threshold);
      if (!low) {
        if (previous?.low) await dao.saveState({ ...args, low: false });
        await connection.commit(); return false;
      }
      if (previous?.low) { await connection.commit(); return false; }
      const recipients = await inbox.staffRecipients({ tenantId: scope.tenantId, permission: "inventory.stock.read", connection });
      // Leave it armed if nobody can receive it; a later scan can notify eligible staff.
      if (!recipients.length) { await connection.commit(); return false; }
      const episodeId = createId();
      await inbox.enqueue({ event: {
        tenantId: scope.tenantId, storeId: source.storeId, audience: "ADMIN", recipients,
        permission: "inventory.stock.read", kind: "INVENTORY_LOW_STOCK", category: "INVENTORY",
        entityType: "INVENTORY_BALANCE", entityId: scope.balanceId,
        key: `INVENTORY_LOW_STOCK:${scope.balanceId}:${episodeId}`,
        title: "Stock at or below reorder level",
        message: `${label(source.productName)} · SKU ${label(source.sku)} · ${label(source.merchantName)} · ${label(source.warehouseName)}. Available balance: ${available.toFixed()} (on hand minus reserved and quarantined). Reorder level: ${new Decimal(balance.threshold).toFixed()}. Snapshot at detection; open inventory for current stock. This is not a storefront-availability check.`
      }, connection });
      await dao.saveState({ ...args, low: true, episodeId });
      await connection.commit(); return true;
    } catch (error) {
      await connection.rollback(); throw error;
    } finally { connection.release(); }
  }

  return { async once({ signal } = {}) {
    const batch = await dao.candidates({ afterId: cursor, limit: 100 });
    let scanned = 0, queued = 0, failed = 0;
    for (const scope of batch) {
      if (signal?.aborted) break;
      try { if (await observe(scope)) queued += 1; }
      catch { failed += 1; } // Sanitized summary; retry this balance on the next full pass.
      cursor = scope.balanceId; scanned += 1;
    }
    const cycleComplete = scanned === batch.length && batch.length < 100;
    if (cycleComplete) cursor = null;
    return { scanned, queued, failed, cycleComplete };
  } };
}
