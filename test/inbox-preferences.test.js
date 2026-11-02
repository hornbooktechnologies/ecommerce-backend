import assert from "node:assert/strict";
import test from "node:test";
import { createInboxPreferencesService } from "../src/modules/notifications/inbox-preferences.service.js";
import { isOptionalCategory } from "../src/modules/notifications/inbox-preferences.rules.js";
import { processNext, unreadCount } from "../src/modules/notifications/inbox.dao.js";
import { uuidToBuffer as id } from "../src/core/identifiers/uuid.js";

const tenantId = "019a3000-1111-7111-8111-111111111111";
const recipientId = "019a3000-2222-7222-8222-222222222222";
const storeId = "019a3000-3333-7333-8333-333333333333";
const eventId = "019a3000-4444-7444-8444-444444444444";
const admin = { audience: "ADMIN", tenantId, recipientId };
const customer = { audience: "CUSTOMER", tenantId, recipientId, storeId };
function fixture({ failAudit = false, inactive = false } = {}) {
  let rows = new Map(); const audits = [];
  const key = (scope) => `${scope.audience}:${scope.tenantId}:${scope.recipientId}:${scope.storeId || ""}`;
  const service = createInboxPreferencesService({ dao: {
    async lockPrincipal() { return !inactive; },
    async read({ scope }) { return rows.get(key(scope)) || null; },
    async save({ scope, disabledCategories }) { const old = rows.get(key(scope)); rows.set(key(scope), { disabledCategories, revision: (old?.revision || 0) + 1 }); },
    async audit(event) { if (failAudit) throw new Error("fixture audit failure"); audits.push(event); }
  }, transaction: async (_tenantId, operation) => {
    const before = structuredClone(rows); const length = audits.length;
    try { return await operation({}); } catch (error) { rows = before; audits.length = length; throw error; }
  } });
  return { service, rows: () => rows, audits };
}
test("preferences default to enabled without a database write", async () => {
  const h = fixture(); const data = await h.service.get(admin);
  assert.equal(data.revision, 0); assert.ok(data.options.every((item) => item.enabled));
  assert.deepEqual(data.required.map((item) => item.category), ["ORDERS", "RETURNS", "PAYMENTS"]);
  assert.equal(h.rows().size, 0);
});
test("customers may change only optional categories, never mandatory delivery/payment updates", async () => {
  const h = fixture();
  await assert.rejects(h.service.save(customer, { revision: 0, disabledCategories: ["ORDERS"] }), { code: "VALIDATION_FAILED" });
  await assert.rejects(h.service.save(customer, { revision: 0, disabledCategories: ["PAYMENTS"] }), { code: "VALIDATION_FAILED" });
  await assert.rejects(h.service.save(customer, { revision: 0, disabledCategories: ["INVENTORY"] }), { code: "VALIDATION_FAILED" });
  const data = await h.service.save(customer, { revision: 0, disabledCategories: ["WARRANTIES"] });
  assert.equal(data.options.find((item) => item.category === "WARRANTIES").enabled, false);
  assert.ok(data.required.every((item) => item.enabled));
});
test("scope comes from authentication, and tenant/store/recipient/audience preferences remain separate", async () => {
  const h = fixture(); await h.service.save(customer, { revision: 0, disabledCategories: ["RETURNS"] });
  for (const scope of [admin, { ...customer, storeId: eventId }, { ...customer, tenantId: eventId }, { ...customer, recipientId: eventId }]) {
    assert.equal((await h.service.get(scope)).revision, 0);
  }
  await assert.rejects(h.service.save(customer, { revision: 1, disabledCategories: [], recipientId: eventId }), { code: "VALIDATION_FAILED" });
});
test("stale revisions cannot overwrite choices; restoring defaults is explicit", async () => {
  const h = fixture(); await h.service.save(admin, { revision: 0, disabledCategories: ["INVENTORY"] });
  await assert.rejects(h.service.save(admin, { revision: 0, disabledCategories: [] }), { code: "PREFERENCES_REVISION_CONFLICT" });
  const data = await h.service.save(admin, { revision: 1, disabledCategories: [] });
  assert.equal(data.revision, 2); assert.ok(data.options.every((item) => item.enabled)); assert.equal(h.audits.length, 2);
});
test("inactive principals, unsupported audiences and audit failures cannot persist changes", async () => {
  const inactive = fixture({ inactive: true });
  await assert.rejects(inactive.service.save(admin, { revision: 0, disabledCategories: [] }), { code: "AUTHENTICATION_REQUIRED" });
  await assert.rejects(inactive.service.get({ ...admin, audience: "PLATFORM" }), { code: "PREFERENCES_UNAVAILABLE" });
  const broken = fixture({ failAudit: true });
  await assert.rejects(broken.service.save(admin, { revision: 0, disabledCategories: ["IMPORTS"] }), /fixture audit failure/);
  assert.equal(broken.rows().size, 0);
});
test("mandatory, unknown, platform and vendor categories always remain enabled", () => {
  for (const [audience, category] of [["ADMIN", "ORDERS"], ["ADMIN", "RETURNS"], ["CUSTOMER", "PAYMENTS"],
    ["PLATFORM", "TENANTS"], ["VENDOR", "ORDERS"], ["ADMIN", "FUTURE_CRITICAL_CATEGORY"]]) assert.equal(isOptionalCategory(audience, category), false);
});
test("worker SQL snapshots only optional category preferences and retains duplicate-row decisions", async () => {
  for (const [audience, category] of [["ADMIN", "INVENTORY"], ["CUSTOMER", "WARRANTIES"], ["CUSTOMER", "ORDERS"]]) {
    const writes = []; const event = { id: id(eventId), tenant_id: id(tenantId), store_id: id(storeId), audience, category,
      recipients: JSON.stringify([recipientId]), recipient_offset: 0, attempt_count: 0 };
    const connection = { async query() {}, async execute(sql, args) {
      if (sql.includes("SELECT * FROM inbox_events")) return [[event]];
      writes.push({ sql, args }); return [{ affectedRows: 1 }];
    } };
    const result = await processNext({ connection }); assert.equal(result.status, "PROCESSED");
    const insert = writes.find((write) => write.sql.includes("INSERT INTO inbox_recipients"));
    assert.ok(insert.sql.includes("ON DUPLICATE KEY UPDATE id = id"));
    assert.equal(insert.sql.includes("inbox_preferences"), isOptionalCategory(audience, category));
    if (isOptionalCategory(audience, category)) {
      assert.equal(insert.sql.includes("suppressed_at"), true); assert.equal(insert.args[8], category);
      assert.deepEqual(insert.args[7], audience === "CUSTOMER" ? id(storeId) : Buffer.alloc(16));
    }
  }
});
test("unread visibility excludes preference-suppressed snapshots", async () => {
  let statement;
  const count = await unreadCount({ scope: admin, connection: { async execute(sql) { statement = sql; return [[{ n: 0 }]]; } } });
  assert.equal(count, 0);
  assert.ok(statement.includes("n.suppressed_at IS NULL"));
});
