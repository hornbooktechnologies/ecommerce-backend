import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

export const states = { AN: "Andaman and Nicobar Islands", AP: "Andhra Pradesh", AR: "Arunachal Pradesh", AS: "Assam", BR: "Bihar", CH: "Chandigarh", CG: "Chhattisgarh", DN: "Dadra and Nagar Haveli and Daman and Diu", DL: "Delhi", GA: "Goa", GJ: "Gujarat", HR: "Haryana", HP: "Himachal Pradesh", JK: "Jammu and Kashmir", JH: "Jharkhand", KA: "Karnataka", KL: "Kerala", LA: "Ladakh", LD: "Lakshadweep", MP: "Madhya Pradesh", MH: "Maharashtra", MN: "Manipur", ML: "Meghalaya", MZ: "Mizoram", NL: "Nagaland", OD: "Odisha", PY: "Puducherry", PB: "Punjab", RJ: "Rajasthan", SK: "Sikkim", TN: "Tamil Nadu", TS: "Telangana", TR: "Tripura", UP: "Uttar Pradesh", UK: "Uttarakhand", WB: "West Bengal" };
const email = Joi.string().trim().lowercase().email({ tlds: { allow: false }, allowUnicode: false }).pattern(/^[\x21-\x7E]+$/).max(254).required();
const name = Joi.string().trim().min(1).max(100).required();
const optional = (max) => Joi.string().trim().max(max).allow("").default("");
const password = Joi.string().min(12).max(128).required();
const phone = Joi.string().trim().pattern(/^\+?[0-9 ()-]{7,20}$/).allow("").default("");
export const schemas = {
  register: Joi.object({ email, firstName: name, lastName: optional(100) }),
  login: Joi.object({ email, password: Joi.string().min(1).max(128).required() }),
  forgot: Joi.object({ email }),
  redeem: Joi.object({ token: Joi.string().pattern(/^[a-f0-9]{64}$/).required(), newPassword: password }),
  password: Joi.object({ currentPassword: Joi.string().max(128).required(), newPassword: password }),
  profile: Joi.object({ firstName: name, lastName: optional(100), phone }),
  address: Joi.object({ label: optional(80), contactName: name, phone: phone.required(),
    line1: Joi.string().trim().min(3).max(255).required(), line2: optional(255), landmark: optional(190),
    city: Joi.string().trim().min(2).max(120).required(),
    stateCode: Joi.string().valid(...Object.keys(states)).required(),
    postalCode: Joi.string().pattern(/^[1-9][0-9]{5}$/).required(), isDefault: Joi.boolean().default(false) })
};
export function validate(schema, input) {
  const { error, value } = schema.required().validate(input, { abortEarly: false });
  if (error) throw new AppError({ code: "VALIDATION_FAILED", message: "Check the highlighted fields.", status: 422,
    details: error.details.map((item) => ({ field: item.path.join("."), message: item.message })) });
  return value;
}
