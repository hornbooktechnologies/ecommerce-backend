import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";
import { withTransaction } from "../../database/transaction.js";
import { validate } from "../customer-accounts/customer-accounts.validators.js";
import * as defaultDao from "./inbox-preferences.dao.js";
import { optionalCategories, preferencesView } from "./inbox-preferences.rules.js";

const fail = (code, message, status) => { throw new AppError({ code, message, status }); };
export function createInboxPreferencesService({ dao = defaultDao, transaction = withTransaction } = {}) {
  function supported(scope) {
    if (!["ADMIN", "CUSTOMER"].includes(scope.audience)) fail("PREFERENCES_UNAVAILABLE", "Preferences are not available for this inbox.", 403);
  }
  return {
    async get(scope) { supported(scope); return preferencesView(scope.audience, await dao.read({ scope })); },
    async save(scope, input) {
      supported(scope);
      const value = validate(Joi.object({ revision: Joi.number().integer().min(0).max(4294967294).required(),
        disabledCategories: Joi.array().items(Joi.string().valid(...optionalCategories(scope.audience)))
          .unique().max(optionalCategories(scope.audience).length).required() }), input);
      const disabledCategories = [...value.disabledCategories].sort();
      return transaction(scope.tenantId, async (connection) => {
        // Serialize first saves as well as updates; no body-supplied recipient IDs.
        if (!await dao.lockPrincipal({ scope, connection })) fail("AUTHENTICATION_REQUIRED", "Your account is unavailable. Sign in again.", 401);
        const current = await dao.read({ scope, connection });
        if ((current?.revision || 0) !== value.revision) fail("PREFERENCES_REVISION_CONFLICT", "Preferences changed in another tab. Reload preferences before saving again.", 409);
        await dao.save({ scope, disabledCategories, connection });
        const next = await dao.read({ scope, connection });
        await dao.audit({ scope, disabledCategories, revision: next.revision, connection });
        return preferencesView(scope.audience, next);
      });
    }
  };
}
