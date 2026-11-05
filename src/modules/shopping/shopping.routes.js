import {adminList as reminderList} from '../reminders/reminders.service.js';
import {listing as reminderListing} from '../reminders/reminders.validators.js';
import {Router} from 'express';
import {authenticate} from '../auth/auth.middleware.js';
import {resolveTenantAccess,requirePermission} from '../access-control/access-control.middleware.js';
import {validate} from '../customer-accounts/customer-accounts.validators.js';
import {listing} from './shopping.validators.js';
import {adminList} from './shopping.service.js';
export function createShoppingAdminRouter(){const router=Router();router.use(authenticate,resolveTenantAccess);router.get('/reminders',requirePermission('customer.read'),async(req,res)=>{res.set('Cache-Control','no-store');res.json({data:await reminderList(req.context.tenant.tenantId,validate(reminderListing,req.query))});});router.get('/',requirePermission('customer.read'),async(req,res)=>{res.set('Cache-Control','no-store');res.json({data:await adminList(req.context.tenant.tenantId,validate(listing,req.query))});});return router;}
