import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";
import { withTransaction } from "../../database/transaction.js";
import * as dao from "./localization.dao.js";
const error = (code, message, status = 422) => {
  throw new AppError({ code, message, status });
};
const timestamp = Joi.string()
  .isoDate()
  .strict()
  .pattern(/(?:Z|[+-]\d{2}:\d{2})$/);
const rate = Joi.object({
  inrPerUnit: Joi.string()
    .pattern(/^(?:[1-9]\d{0,6}|0)(?:\.\d{1,8})?$/)
    .required(),
  asOf: timestamp.required(),
  validUntil: timestamp.required(),
}).unknown(false);
export const settingsSchema = Joi.object({
  revision: Joi.number().integer().min(0).required(),
  defaultLanguage: Joi.string().valid("en", "hi", "gu").required(),
  languages: Joi.array()
    .items(Joi.string().valid("en", "hi", "gu"))
    .unique()
    .min(1)
    .max(3)
    .required(),
  currencies: Joi.array()
    .items(Joi.string().valid("INR", "USD", "EUR"))
    .unique()
    .min(1)
    .max(3)
    .required(),
  rates: Joi.object({ USD: rate.allow(null), EUR: rate.allow(null) })
    .unknown(false)
    .required(),
}).unknown(false);
export const defaultSettings = () => ({
  defaultLanguage: "en",
  languages: ["en", "hi", "gu"],
  currencies: ["INR", "USD", "EUR"],
  rates: { USD: null, EUR: null },
  revision: 0,
});
export function publicSettings(settings, tenantId, storeId, now = Date.now()) {
  const rates = { INR: 1 },
    rateDetails = {};
  for (const currency of ["USD", "EUR"]) {
    const row = settings.rates[currency];
    if (
      settings.currencies.includes(currency) &&
      row &&
      Number(row.inrPerUnit) > 0 &&
      new Date(row.asOf).getTime() <= now &&
      new Date(row.validUntil).getTime() > now
    ) {
      rates[currency] = Number(row.inrPerUnit);
      rateDetails[currency] = { asOf: row.asOf, validUntil: row.validUntil };
    }
  }
  return {
    schemaVersion: 1,
    scopeKey: `${tenantId}_${storeId}`,
    defaultLanguage: settings.defaultLanguage,
    languages: settings.languages,
    currencies: settings.currencies,
    availableCurrencies: settings.currencies.filter((code) => rates[code]),
    baseCurrency: "INR",
    checkoutCurrency: "INR",
    mode: "DISPLAY_ONLY",
    inrPerUnit: rates,
    rateDetails,
    revision: settings.revision,
  };
}
export async function readSettings(tenantId, storeId) {
  const store = await dao.store({ tenantId, storeId });
  if (!store) error("STORE_NOT_FOUND", "Store was not found.", 404);
  return {
    ...((await dao.find({ tenantId, storeId })) || defaultSettings()),
    baseCurrency: store.base_currency,
    mode: "DISPLAY_ONLY",
  };
}
export async function storefrontSettings(scope) {
  return publicSettings(
    (await dao.find(scope)) || defaultSettings(),
    scope.tenantId,
    scope.storeId,
  );
}
export async function saveSettings(tenantId, storeId, raw, context) {
  const checked = settingsSchema.validate(raw, { abortEarly: false });
  if (checked.error)
    error(
      "LOCALIZATION_INVALID",
      checked.error.details.map((row) => row.message).join(" "),
    );
  const input = checked.value;
  if (
    !input.languages.includes("en") ||
    !input.languages.includes(input.defaultLanguage) ||
    !input.currencies.includes("INR")
  )
    error(
      "LOCALIZATION_INVALID",
      "English fallback, the default language and INR must stay enabled.",
    );
  const now = Date.now();
  for (const [code, row] of Object.entries(input.rates)) {
    if (!row) continue;
    const at = new Date(row.asOf).getTime(),
      until = new Date(row.validUntil).getTime();
    if (
      Number(row.inrPerUnit) <= 0 ||
      at > now ||
      until <= now ||
      until <= at ||
      until - at > 31 * 86400000
    )
      error(
        "LOCALIZATION_RATE_INVALID",
        `${code}: use a positive INR-per-unit rate with a past/current reference time and an expiry within 31 days of that reference.`,
      );
  }
  return withTransaction(tenantId, async (connection) => {
    const scope = { tenantId, storeId, connection };
    const store = await dao.store({ ...scope, lock: true });
    if (!store) error("STORE_NOT_FOUND", "Store was not found.", 404);
    if (store.base_currency !== "INR")
      error(
        "LOCALIZATION_BASE_CURRENCY",
        "This display conversion supports INR-base stores only.",
        409,
      );
    const current = (await dao.find(scope)) || defaultSettings();
    if (current.revision !== input.revision)
      error(
        "LOCALIZATION_CHANGED",
        "Settings changed. Reload before saving again.",
        409,
      );
    await dao.save({ ...scope, input, context });
    return {
      ...(await dao.find(scope)),
      baseCurrency: "INR",
      mode: "DISPLAY_ONLY",
    };
  });
}
