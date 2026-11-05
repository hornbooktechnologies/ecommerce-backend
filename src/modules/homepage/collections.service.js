import { AppError } from '../../core/errors/app-error.js';
import { createId } from '../../core/identifiers/uuid.js';
import { withTransaction } from '../../database/transaction.js';
import * as dao from './collections.dao.js';
import * as stores from '../store-operations/store-operations.dao.js';
import * as assets from './homepage.dao.js';
import * as catalog from '../storefront/storefront.dao.js';
import { collectionScope } from './sections-scope.dao.js';
const fail = (code, message, status = 422) => {
  throw new AppError({ code, message, status });
};
export const collectionActive = (row, at = Date.now()) =>
  Boolean(
    row?.visible &&
    row.published &&
    (!row.published.startsAt || Date.parse(row.published.startsAt) <= at) &&
    (!row.published.endsAt || at < Date.parse(row.published.endsAt)),
  );
async function scopeFor(tenantId, storeId, connection, lock = false) {
  const store = await stores.findStore({
    tenantId,
    storeId,
    connection,
    forUpdate: lock,
  });
  if (!store) fail('STORE_NOT_FOUND', 'Store was not found.', 404);
  return { tenantId, storeId, currency: store.baseCurrency };
}
export async function collectionForLink(
  scope,
  href,
  { connection, live = false } = {},
) {
  if (!href?.startsWith('/collections/')) return true;
  const row = await dao.find({ ...scope, slug: href.slice(13), connection });
  return Boolean(
    row?.visible &&
    row.published &&
    (!live || collectionActive(row)) &&
    (await collectionScope({ ...scope, section: row.published, connection })),
  );
}
export async function renderCollection(
  scope,
  row,
  query = {},
  connection,
  { preview = false } = {},
) {
  const document = preview ? row?.draft : row?.published;
  if (!document || (!preview && !collectionActive(row))) return null;
  const filters = await collectionScope({
    ...scope,
    section: document,
    connection,
  });
  if (!filters) return null;
  const { search = '', sort = 'curated', page = 1, pageSize = 10 } = query;
  const products = await catalog.listProducts({
    scope,
    connection,
    filters: {
      ...filters,
      search,
      page,
      pageSize,
      sort:
        sort === 'curated'
          ? {
              NEWEST: 'newest',
              DISCOUNT: 'discount',
              REVIEWS: 'review_count',
              MANUAL: 'manual',
            }[document.rule]
          : sort,
      ...(document.rule === 'DISCOUNT' ? { minDiscount: 0.000001 } : {}),
      ...(document.rule === 'MANUAL'
        ? {
            productSlugs: document.productSlugs,
            productSlugOrder: document.productSlugs,
          }
        : {}),
    },
  });
  return {
    id: row.id,
    slug: row.slug,
    title: document.title,
    description: document.description,
    imageUrl: document.imageUrl,
    altText: document.altText,
    seoTitle: document.seoTitle,
    seoDescription: document.seoDescription,
    publishedAt: row.publishedAt,
    ...products,
  };
}
async function validate(scope, document, connection, publishing) {
  if (!(await collectionScope({ ...scope, section: document, connection })))
    fail(
      'COLLECTION_SCOPE_INVALID',
      'Choose active brand/category values from this tenant.',
    );
  if (
    document.imageUrl &&
    !(await assets.ownsAsset({ ...scope, url: document.imageUrl, connection }))
  )
    fail('COLLECTION_IMAGE_INVALID', 'Upload the banner image for this store.');
  if (document.imageUrl && !document.altText)
    fail(
      'COLLECTION_ALT_REQUIRED',
      'Describe the banner image for screen readers.',
    );
  if (publishing && document.rule === 'MANUAL') {
    if (!document.productSlugs.length)
      fail(
        'COLLECTION_PRODUCTS_REQUIRED',
        'Choose at least one product for a manual collection.',
      );
    // Bounded catalog lookup, with live scope and offer eligibility, avoids per-product queries.
    const selected = await catalog.listProducts({
      scope,
      connection,
      filters: {
        productSlugs: document.productSlugs,
        page: 1,
        pageSize: 100,
        sort: 'featured',
      },
    });
    if (selected.total !== document.productSlugs.length)
      fail(
        'COLLECTION_PRODUCTS_UNAVAILABLE',
        'Remove or replace unpublished/unavailable products before publishing.',
      );
  }
}
export async function listCollections(tenantId, storeId, input) {
  await scopeFor(tenantId, storeId);
  return dao.list({ tenantId, storeId, ...input });
}
export async function readCollection(tenantId, storeId, collectionId) {
  await scopeFor(tenantId, storeId);
  const row = await dao.find({ tenantId, storeId, collectionId });
  if (!row) fail('COLLECTION_NOT_FOUND', 'Collection was not found.', 404);
  return row;
}
export async function previewCollection(tenantId, storeId, document) {
  const scope = await scopeFor(tenantId, storeId);
  await validate(scope, document, undefined, false);
  return renderCollection(
    scope,
    { draft: document },
    { page: 1, pageSize: 12 },
    undefined,
    { preview: true },
  );
}
export async function mutateCollection(
  tenantId,
  storeId,
  collectionId,
  input,
  context,
  mode,
) {
  return withTransaction(tenantId, async (connection) => {
    const scope = await scopeFor(tenantId, storeId, connection, true);
    let current;
    if (mode === 'create') {
      if ((await dao.list({ ...scope, pageSize: 1, connection })).total >= 200)
        fail('COLLECTION_LIMIT', 'This store supports up to 200 collections.');
      if (await dao.find({ ...scope, slug: input.slug, connection }))
        fail(
          'COLLECTION_SLUG_EXISTS',
          'This collection URL already exists in this store.',
          409,
        );
      collectionId = createId();
      await validate(scope, input.document, connection, false);
      await dao.insert({
        ...scope,
        collectionId,
        slug: input.slug,
        document: input.document,
        connection,
      });
    } else {
      current = await dao.find({ ...scope, collectionId, connection });
      if (!current)
        fail('COLLECTION_NOT_FOUND', 'Collection was not found.', 404);
      if (current.revision !== input.revision)
        fail(
          'COLLECTION_CHANGED',
          'Another user changed this collection. Reload before saving.',
          409,
        );
      if (mode !== 'withdraw')
        await validate(
          scope,
          mode === 'publish' ? current.draft : input.document,
          connection,
          mode === 'publish',
        );
      await dao.change({
        ...scope,
        collectionId,
        mode,
        document: input.document,
        connection,
      });
    }
    await stores.insertAudit({
      audit: {
        id: createId(),
        ...scope,
        actorUserId: context.actorUserId,
        action: `STORE_COLLECTION_${mode.toUpperCase()}`,
        entityType: 'STORE_COLLECTION',
        entityId: collectionId,
        requestId: context.requestId,
        ipAddress: context.ipAddress || '127.0.0.1',
        userAgent: context.userAgent || null,
        afterData: { collectionId, slug: current?.slug || input.slug },
      },
      connection,
    });
    return dao.find({ ...scope, collectionId, connection });
  });
}
export async function publicCollection(scope, slug, query) {
  const row = await dao.find({ ...scope, slug });
  const result = await renderCollection(scope, row, query);
  if (!result) fail('COLLECTION_NOT_FOUND', 'Collection is unavailable.', 404);
  return result;
}
export async function publicCollectionIndex(scope, query) {
  // Store limit is 200. Filter schedules/scopes before pagination, so private/future rows never leak or inflate counts.
  const rows = await dao.list({
    ...scope,
    publicOnly: true,
    page: 1,
    pageSize: 200,
  });
  const items = [];
  for (const row of rows.items)
    if (
      collectionActive(row) &&
      (await collectionScope({ ...scope, section: row.published }))
    )
      items.push({
        slug: row.slug,
        title: row.published.title,
        description: row.published.description,
        imageUrl: row.published.imageUrl,
        altText: row.published.altText,
        publishedAt: row.publishedAt,
      });
  const page = query.page || 1,
    pageSize = query.pageSize || 10;
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: items.length,
    totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
  };
}
