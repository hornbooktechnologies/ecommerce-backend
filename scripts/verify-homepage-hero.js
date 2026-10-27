// Exercises the real MariaDB DAO and publication service inside a rolled-back transaction.
import assert from "node:assert/strict";
import { getPrimaryPool, closePrimaryPool } from "../src/database/pool-factory.js";
import { createId } from "../src/core/identifiers/uuid.js";
import { findUserByEmail } from "../src/modules/auth/auth.dao.js";
import { resolveStore, listProducts } from "../src/modules/storefront/storefront.dao.js";
import * as dao from "../src/modules/homepage/homepage.dao.js";
import { createHomepageService, publicHero, emptyHero } from "../src/modules/homepage/homepage.service.js";
import * as sectionsDao from "../src/modules/homepage/sections.dao.js";
import { createSectionsService, defaultSections, renderSections } from "../src/modules/homepage/sections.service.js";

const connection = await getPrimaryPool().getConnection();
try {
  const scope = await resolveStore({ tenantCode: process.env.HERO_VERIFY_TENANT || "HORNBOOK_RETAIL", storeCode: process.env.HERO_VERIFY_STORE || "MAIN", connection });
  assert.ok(scope, "An active test store is required.");
  const user = await findUserByEmail({ email: process.env.HERO_VERIFY_USER_EMAIL || "admin@example.com", connection });
  assert.ok(user, "An audit actor is required. Set HERO_VERIFY_USER_EMAIL.");
  const original = await dao.readHero({ ...scope, connection });
  const originalSections = await sectionsDao.read({ ...scope, connection });
  const { items } = await listProducts({ scope, filters: { page: 1, pageSize: 1 }, connection });
  assert.ok(items[0], "A published product with an active store offer is required.");
  await connection.beginTransaction();
  const service = createHomepageService({ transaction: async (_tenantId, operation) => operation(connection) });
  const context = { actorUserId: user.id, requestId: createId(), ipAddress: "127.0.0.1", userAgent: "hero-rollback-verification" };
  const draft = { ...emptyHero(), slides: [{ id: createId(), enabled: true, eyebrow: "Verification",
    title: "", description: "", imageUrl: "", altText: "", productSlug: items[0].slug,
    href: `/p/${items[0].slug}`, ctaLabel: "Explore", tone: "sage", showPrice: true }] };
  const saved = await service.save(scope.tenantId, scope.storeId, { revision: original?.revision || 0, document: draft }, context);
  assert.deepEqual(saved.published, original?.published || null);
  const published = await service.save(scope.tenantId, scope.storeId, { revision: saved.revision }, context, true);
  assert.equal(published.published.slides[0].productSlug, items[0].slug);
  const visible = await publicHero(scope, { dao: { readHero: (input) => dao.readHero({ ...input, connection }) } });
  assert.equal(visible.slides[0].title, items[0].name);
  assert.equal(visible.slides[0].product.price, items[0].price);
  const sectionsService = createSectionsService({ transaction: async (_tenantId, operation) => operation(connection) });
  const sectionsDraft = await sectionsService.save(scope.tenantId, scope.storeId,
    { revision: originalSections?.revision || 0, document: defaultSections() }, context);
  assert.deepEqual(sectionsDraft.published, originalSections?.published || null);
  const sectionsPublished = await sectionsService.save(scope.tenantId, scope.storeId, { revision: sectionsDraft.revision }, context, true);
  const rendered = await renderSections(scope, sectionsPublished.published, { connection });
  assert.ok(rendered.sections.some((section) => section.key === "FRESH" && section.items.length));
  assert.ok(rendered.sections.every((section) => section.items.length <= 6));
  await connection.rollback();
  assert.deepEqual(await dao.readHero({ ...scope, connection }), original);
  assert.deepEqual(await sectionsDao.read({ ...scope, connection }), originalSections);
  process.stdout.write("PASS: MariaDB hero and section drafts, publication, audit, automatic catalog rules and rollback. No live content changed.\n");
} finally {
  await connection.rollback(); connection.release(); await closePrimaryPool();
}
