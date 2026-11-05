import { randomBytes } from 'node:crypto';
import { AppError } from '../../core/errors/app-error.js';
import { logger } from '../../config/logger.js';
import { collectionActive } from '../homepage/collections.service.js';
import { sectionActiveAt } from '../homepage/sections.service.js';
import * as collections from '../homepage/collections.dao.js';
import * as heroes from '../homepage/homepage.dao.js';
import * as sections from '../homepage/sections.dao.js';
import { collectionScope } from '../homepage/sections-scope.dao.js';
import * as catalog from '../storefront/storefront.dao.js';
import { findStore } from '../store-operations/store-operations.dao.js';
import { limit } from '../customer-accounts/customer-accounts.dao.js';
import * as dao from './merchandising.dao.js';
const fail = (code, message, status = 422) => {
  throw new AppError({ code, message, status });
};
export async function resolveSource(
  scope,
  { sourceKind, sourceKey },
  connection,
) {
  let row, label;
  if (sourceKind === 'COLLECTION') {
    row = await collections.find({ ...scope, slug: sourceKey, connection });
    label = row?.published?.title;
  } else if (sourceKind === 'HERO') {
    const config = (await heroes.readHero({ ...scope, connection }))?.published,
      slide =
        config?.enabled &&
        config.slides.find(
          (item) =>
            item.id === sourceKey &&
            item.enabled &&
            !item.productSlug &&
            item.href.startsWith('/collections/'),
        );
    if (slide) {
      row = await collections.find({
        ...scope,
        slug: slide.href.slice(13),
        connection,
      });
      label = slide.title || row?.published?.title;
    }
  } else {
    const item = (
      await sections.read({ ...scope, connection })
    )?.published?.sections.find((item) => item.key === sourceKey);
    if (!item || !sectionActiveAt(item)) return null;
    if (
      sourceKind === 'BANNER' &&
      item.key === 'BANNER' &&
      item.imageUrl &&
      item.href.startsWith('/collections/')
    )
      row = await collections.find({
        ...scope,
        slug: item.href.slice(13),
        connection,
      });
    if (sourceKind === 'SHELF' && item.key !== 'BANNER' && item.collectionId)
      row = await collections.find({
        ...scope,
        collectionId: item.collectionId,
        connection,
      });
    label = item.title;
  }
  if (!collectionActive(row)) return null;
  const filters = await collectionScope({
    ...scope,
    section: row.published,
    connection,
  });
  if (!filters) return null;
  return {
    collection: row,
    label: label || row.published.title,
    filters,
    sourceKind,
    sourceKey,
  };
}
export async function settings(scope, token) {
  const current = await dao.session({ ...scope, token });
  return { enabled: Boolean(current), expiresAt: current?.expiresAt || null };
}
export async function consent(scope, token, input) {
  if (!input.enabled) {
    await dao.disable({ ...scope, token });
    return { enabled: false, expiresAt: null };
  }
  const existing = await dao.session({ ...scope, token });
  if (existing) return { enabled: true, expiresAt: existing.expiresAt };
  await dao.scrubExpired();
  const sessionToken = randomBytes(32).toString('hex');
  await dao.enable({ ...scope, token: sessionToken });
  const row = await dao.session({ ...scope, token: sessionToken });
  return { enabled: true, expiresAt: row.expiresAt, sessionToken };
}
export async function rateLimit(scope, ip, token) {
  const current = await dao.session({ ...scope, token });
  const bucket = current ? `session:${current.id}` : `consent:${ip}`;
  if (
    !(await limit({
      bucketHash: dao.hash(
        `${scope.tenantId}:${scope.storeId}:merchandising:${bucket}`,
      ),
      maximum: 240,
    }))
  )
    fail('TOO_MANY_ATTEMPTS', 'Too many analytics requests.', 429);
}
export async function record(scope, token, input) {
  const session = await dao.session({ ...scope, token });
  if (!session) return { recorded: false };
  let selected = await resolveSource(scope, input);
  if (!selected)
    fail(
      'MERCHANDISING_SOURCE_UNAVAILABLE',
      'This collection placement is unavailable.',
      404,
    );
  if (input.kind === 'OPEN' && input.sourceKind === 'COLLECTION')
    fail('MERCHANDISING_EVENT_INVALID', 'Choose a campaign placement.');
  let productId = null;
  if (input.kind === 'CLICK') {
    const doc = selected.collection.published;
    if (doc.rule === 'MANUAL' && !doc.productSlugs.includes(input.productSlug))
      fail(
        'MERCHANDISING_PRODUCT_UNAVAILABLE',
        'Product is not in this collection.',
        404,
      );
    const result = await catalog.listProducts({
      scope,
      filters: {
        ...selected.filters,
        productSlugs: [input.productSlug],
        ...(doc.rule === 'DISCOUNT' ? { minDiscount: 0.000001 } : {}),
        page: 1,
        pageSize: 1,
        sort: 'featured',
      },
    });
    if (!result.items[0])
      fail(
        'MERCHANDISING_PRODUCT_UNAVAILABLE',
        'Product is not in this collection.',
        404,
      );
    productId = result.items[0].id;
    if (input.sourceKind === 'COLLECTION') {
      const previous = await dao.lastOpen({
        scope,
        sessionId: session.id,
        collectionId: selected.collection.id,
      });
      const campaign = previous && (await resolveSource(scope, previous));
      if (campaign?.collection.id === selected.collection.id)
        selected = campaign;
    }
  }
  const sourceId = await dao.source({ scope, ...selected });
  await dao.event({
    scope,
    sessionId: session.id,
    sourceId,
    kind: input.kind,
    productId,
    dedupe: `${Math.floor(Date.now() / 1800000)}:${sourceId}:${input.kind}:${productId || ''}`,
  });
  return { recorded: true };
}
export async function optional(operation) {
  try {
    return await operation();
  } catch (error) {
    if (
      ['ER_LOCK_DEADLOCK', 'PROTOCOL_CONNECTION_LOST', 'ECONNRESET'].includes(
        error.code,
      )
    )
      throw error;
    logger.warn(
      { code: error.code || 'UNAVAILABLE' },
      'Optional merchandising analytics unavailable; commerce operation continues',
    );
    return null;
  }
}
export async function recordCartAdd(
  scope,
  token,
  { productId, ownerKey, revision, quantity, previousQuantity },
  connection,
) {
  if (quantity <= previousQuantity) return null;
  const session = await dao.session({ ...scope, token, connection });
  if (!session) return null;
  const click = await dao.lastClick({
    scope,
    sessionId: session.id,
    productId,
    connection,
  });
  if (!click) return null;
  await dao.event({
    scope,
    sessionId: session.id,
    sourceId: click.sourceId,
    kind: 'ADD',
    productId,
    dedupe: `ADD:${ownerKey}:${revision}:${productId}`,
    connection,
  });
  return click.id;
}
export async function recordOrder(
  scope,
  token,
  { orderId, items },
  connection,
) {
  const session = await dao.session({ ...scope, token, connection });
  if (session)
    await dao.convert({
      scope,
      sessionId: session.id,
      orderId,
      items,
      connection,
    });
}
export async function report(tenantId, storeId, filters) {
  const store = await findStore({ tenantId, storeId });
  if (!store) fail('STORE_NOT_FOUND', 'Store was not found.', 404);
  return {
    ...(await dao.report({ scope: { tenantId, storeId }, filters })),
    currency: store.baseCurrency,
  };
}
