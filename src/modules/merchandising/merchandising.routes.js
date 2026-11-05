import { Router } from 'express';
import Joi from 'joi';
import { authenticate } from '../auth/auth.middleware.js';
import {
  requirePermission,
  resolveTenantAccess,
} from '../access-control/access-control.middleware.js';
import { validate } from '../customer-accounts/customer-accounts.validators.js';
import {
  storeParamsSchema,
  validateParams,
  validateQuery,
} from '../store-operations/store-operations.validators.js';
import { resolveStore } from '../storefront/storefront.dao.js';
import { AppError } from '../../core/errors/app-error.js';
import * as schemas from './merchandising.validators.js';
import * as service from './merchandising.service.js';
import { storeChoices } from './merchandising.dao.js';
export function createMerchandisingPublicRouter() {
  const router = Router(),
    base = '/:tenantCode/stores/:storeCode/merchandising';
  for (const [method, action, schema] of [
    ['get', 'settings', null],
    ['post', 'consent', schemas.consentSchema],
    ['post', 'events', schemas.eventSchema],
  ])
    router[method](`${base}/${action}`, async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
      const params = validate(schemas.scopeSchema, req.params),
        input = schema ? validate(schema, req.body) : {};
      const scope = await resolveStore(params);
      if (!scope)
        throw new AppError({
          code: 'STORE_NOT_FOUND',
          message: 'Store is unavailable.',
          status: 404,
        });
      const token = req.get('x-merchandising-token') || '';
      await service.rateLimit(scope, req.ip, token);
      if (req.get('sec-gpc') === '1' || req.get('dnt') === '1') {
        await service.consent(scope, token, { enabled: false });
        return res.json({
          data: { enabled: false, recorded: false, privacySignal: true },
        });
      }
      if (action === 'settings')
        return res.json({ data: await service.settings(scope, token) });
      res.json({
        data:
          action === 'consent'
            ? await service.consent(scope, token, input)
            : await service.record(scope, token, input),
      });
    });
  return router;
}
export function createMerchandisingAdminRouter({
  resolveTenant = resolveTenantAccess,
  authorize = requirePermission,
} = {}) {
  const router = Router();
  router.get(
    '/merchandising-report/stores',
    authenticate,
    resolveTenant,
    authorize('report.sales.read'),
    validateQuery(
      Joi.object({
        search: Joi.string().trim().max(120).allow('').default(''),
      }),
    ),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({
        data: await storeChoices({
          tenantId: req.context.tenant.tenantId,
          ...req.validated.query,
        }),
      });
    },
  );
  router.get(
    '/stores/:storeId/merchandising-report',
    authenticate,
    resolveTenant,
    authorize('report.sales.read'),
    validateParams(storeParamsSchema),
    validateQuery(schemas.reportSchema),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({
        data: await service.report(
          req.context.tenant.tenantId,
          req.validated.params.storeId,
          req.validated.query,
        ),
      });
    },
  );
  return router;
}
