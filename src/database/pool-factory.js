import mysql from "mysql2/promise";
import { env } from "../config/env.js";

let primaryPool;

export function getPrimaryPool() {
  if (!primaryPool) {
    primaryPool = mysql.createPool({
      host: env.database.host,
      port: env.database.port,
      database: env.database.name,
      user: env.database.user,
      password: env.database.password,
      connectionLimit: env.database.connectionLimit,
      waitForConnections: true,
      queueLimit: 0,
      timezone: "Z",
      charset: "utf8mb4",
      decimalNumbers: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      namedPlaceholders: false
    });
  }

  return primaryPool;
}

export async function closePrimaryPool() {
  if (primaryPool) {
    await primaryPool.end();
    primaryPool = undefined;
  }
}
