import { Router } from 'express';
import { authenticate } from '../auth/auth.middleware.js';
import {
  requirePermission,
  resolveTenantAccess,
} from '../access-control/access-control.middleware.js';
import {
  storeParamsSchema,
  validateParams,
  validateBody,
  validateQuery,
} from '../store-operations/store-operations.validators.js';
import * as schemas from './collections.validators.js';
import * as service from './collections.service.js';
export function createCollectionsRouter() {
  const router = Router(),
    base = '/stores/:storeId/collections';
  const scope = (req) => [
    req.context.tenant.tenantId,
    req.validated.params.storeId,
  ];
  const context = (req) => ({
    actorUserId: req.context.actor.userId,
    requestId: req.context.requestId,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
  router.use(base, authenticate, resolveTenantAccess, (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get(
    base,
    validateParams(storeParamsSchema),
    requirePermission('settings.store.read'),
    validateQuery(schemas.collectionList),
    async (req, res) =>
      res.json({
        data: await service.listCollections(...scope(req), req.validated.query),
      }),
  );
  router.post(
    base,
    validateParams(storeParamsSchema),
    requirePermission('settings.store.manage'),
    validateBody(schemas.collectionCreate),
    async (req, res) =>
      res
        .status(201)
        .json({
          data: await service.mutateCollection(
            ...scope(req),
            null,
            req.validated.body,
            context(req),
            'create',
          ),
        }),
  );
  router.post(
    `${base}/preview`,
    validateParams(storeParamsSchema),
    requirePermission('settings.store.read'),
    validateBody(schemas.collectionDocument),
    async (req, res) =>
      res.json({
        data: await service.previewCollection(
          ...scope(req),
          req.validated.body,
        ),
      }),
  );
  router.get(
    `${base}/:collectionId`,
    validateParams(schemas.collectionParams),
    requirePermission('settings.store.read'),
    async (req, res) =>
      res.json({
        data: await service.readCollection(
          ...scope(req),
          req.validated.params.collectionId,
        ),
      }),
  );
  router.put(
    `${base}/:collectionId`,
    validateParams(schemas.collectionParams),
    requirePermission('settings.store.manage'),
    validateBody(schemas.collectionSave),
    async (req, res) =>
      res.json({
        data: await service.mutateCollection(
          ...scope(req),
          req.validated.params.collectionId,
          req.validated.body,
          context(req),
          'save',
        ),
      }),
  );
  for (const action of ['publish', 'withdraw'])
    router.post(
      `${base}/:collectionId/${action}`,
      validateParams(schemas.collectionParams),
      requirePermission('settings.store.manage'),
      validateBody(schemas.collectionRevision),
      async (req, res) =>
        res.json({
          data: await service.mutateCollection(
            ...scope(req),
            req.validated.params.collectionId,
            req.validated.body,
            context(req),
            action,
          ),
        }),
    );
  return router;
}
