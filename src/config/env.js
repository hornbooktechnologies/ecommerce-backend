import "dotenv/config";
import Joi from "joi";

const schema = Joi.object({
  NODE_ENV: Joi.string().valid("development", "test", "production").default("development"),
  PORT: Joi.number().port().default(4000),
  LOG_LEVEL: Joi.string().valid("fatal", "error", "warn", "info", "debug", "trace", "silent").default("info"),
  CORS_ORIGINS: Joi.string().default("http://localhost:3000"),
  DB_HOST: Joi.string().default("127.0.0.1"),
  DB_PORT: Joi.number().port().default(3306),
  DB_NAME: Joi.string().default("ecommerce"),
  DB_USER: Joi.string().default("ecommerce"),
  DB_PASSWORD: Joi.string().allow("").default("ecommerce_local"),
  DB_CONNECTION_LIMIT: Joi.number().integer().min(1).max(100).default(10),
  ACCESS_TOKEN_SECRET: Joi.string().min(32).default("development-access-token-secret-change-me"),
  REFRESH_TOKEN_SECRET: Joi.string().min(32).default("development-refresh-token-secret-change-me"),
  PASSWORD_RESET_SECRET: Joi.string().min(32).default("development-password-reset-secret-change-me"),
  ADMIN_APP_URL: Joi.string().uri({ allowRelative: false }).default("http://localhost:3000"),
  API_PUBLIC_URL: Joi.string().uri({ allowRelative: false }).allow(""),
  PRODUCT_MEDIA_DIRECTORY: Joi.string().default("storage/product-media"),
  VENDOR_LOGO_DIRECTORY: Joi.string().default("storage/vendor-logos"),
  VENDOR_DOCUMENT_DIRECTORY: Joi.string().default("storage/vendor-documents")
}).unknown(true);

const { value, error } = schema.validate(process.env, {
  abortEarly: false,
  convert: true
});

if (error) {
  throw new Error(`Invalid environment configuration: ${error.message}`);
}

export const env = Object.freeze({
  nodeEnv: value.NODE_ENV,
  port: value.PORT,
  logLevel: value.LOG_LEVEL,
  corsOrigins: value.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
  database: Object.freeze({
    host: value.DB_HOST,
    port: value.DB_PORT,
    name: value.DB_NAME,
    user: value.DB_USER,
    password: value.DB_PASSWORD,
    connectionLimit: value.DB_CONNECTION_LIMIT
  }),
  accessTokenSecret: value.ACCESS_TOKEN_SECRET,
  refreshTokenSecret: value.REFRESH_TOKEN_SECRET,
  passwordResetSecret: value.PASSWORD_RESET_SECRET,
  adminAppUrl: value.ADMIN_APP_URL.replace(/\/$/, ""),
  apiPublicUrl: (value.API_PUBLIC_URL || `http://localhost:${value.PORT}`).replace(/\/$/, ""),
  productMediaDirectory: value.PRODUCT_MEDIA_DIRECTORY,
  vendorLogoDirectory: value.VENDOR_LOGO_DIRECTORY,
  vendorDocumentDirectory: value.VENDOR_DOCUMENT_DIRECTORY
});
