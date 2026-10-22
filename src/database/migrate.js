import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const lockName = "ecommerce_schema_migrations";

function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function migrate() {
  const connection = await mysql.createConnection({
    host: env.database.host,
    port: env.database.port,
    database: env.database.name,
    user: env.database.user,
    password: env.database.password,
    timezone: "Z",
    charset: "utf8mb4",
    multipleStatements: true
  });

  try {
    const [[lock]] = await connection.query("SELECT GET_LOCK(?, 30) AS acquired", [lockName]);
    if (lock.acquired !== 1) {
      throw new Error("Could not acquire the database migration lock.");
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(40) NOT NULL,
        name VARCHAR(255) NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const files = (await readdir(migrationDirectory))
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();

    for (const file of files) {
      const version = file.split("_")[0];
      const sql = await readFile(join(migrationDirectory, file), "utf8");
      const digest = checksum(sql);
      const [appliedRows] = await connection.execute(
        "SELECT checksum FROM schema_migrations WHERE version = ? LIMIT 1",
        [version]
      );

      if (appliedRows.length > 0) {
        if (appliedRows[0].checksum !== digest) {
          throw new Error(`Migration ${file} changed after it was applied.`);
        }
        logger.info({ migration: file }, "Migration already applied");
        continue;
      }

      logger.info({ migration: file }, "Applying migration");
      await connection.query(sql);
      await connection.execute(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)",
        [version, file, digest]
      );
      logger.info({ migration: file }, "Migration applied");
    }
  } finally {
    try {
      await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
    } finally {
      await connection.end();
    }
  }
}

migrate().catch((error) => {
  logger.fatal({ error }, "Database migration failed");
  process.exitCode = 1;
});
