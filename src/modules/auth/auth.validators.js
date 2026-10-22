import Joi from "joi";
import { AppError } from "../../core/errors/app-error.js";

export const loginSchema = Joi.object({
  email: Joi.string().email().max(254).required(),
  password: Joi.string().min(12).max(200).required(),
  deviceName: Joi.string().trim().max(190).allow("").optional()
}).required();

export const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().max(254).required()
}).required();

export const resetPasswordSchema = Joi.object({
  token: Joi.string().trim().min(32).max(500).required(),
  newPassword: Joi.string().min(12).max(200).required()
}).required();

export const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().min(12).max(200).required(),
  newPassword: Joi.string().min(12).max(200).required()
}).required();

export function validateBody(schema) {
  return (req, _res, next) => {
    const { value, error } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      return next(new AppError({
        code: "VALIDATION_FAILED",
        message: "Check the highlighted fields and try again.",
        status: 422,
        details: error.details.map((detail) => ({
          field: detail.path.join("."),
          code: detail.type,
          message: detail.message
        }))
      }));
    }

    req.validated = { body: value };
    next();
  };
}
