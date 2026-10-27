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
    // mysql2's timezone option controls JS date conversion, not MariaDB's session
    // clock. Queue this before the connection's first application query so
    // CURRENT_TIMESTAMP defaults and explicit UTC_TIMESTAMP writes agree.
    primaryPool.on("connection", (connection) => {
      connection.query("SET time_zone = '+00:00'", (error) => {
        if (error) connection.destroy();
      });
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
