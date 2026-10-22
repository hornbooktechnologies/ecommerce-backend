import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(testDirectory, "..", "src", "database", "migrations", "001_initial_schema.sql");
const jobsMigrationPath = join(
  testDirectory,
  "..",
  "src",
  "database",
  "migrations",
  "002_background_jobs.sql"
);

test("baseline schema has complete table statements and valid references", async () => {
  const sql = await readFile(schemaPath, "utf8");
  const tables = [...sql.matchAll(/^CREATE TABLE\s+([a-z0-9_]+)/gim)].map((match) => match[1]);
  const tableEndings = [...sql.matchAll(/^\) ENGINE=InnoDB /gim)];
  const references = [...sql.matchAll(/REFERENCES\s+([a-z0-9_]+)/gi)].map((match) => match[1]);

  assert.equal(tables.length, 105);
  assert.equal(tableEndings.length, tables.length);
  assert.equal(new Set(tables).size, tables.length);

  for (const referencedTable of references) {
    assert.ok(tables.includes(referencedTable), `Missing referenced table: ${referencedTable}`);
  }

  for (const commerceTable of ["products", "product_variants", "product_substitutes",
    "inventory_balances", "inventory_lots", "serial_numbers", "delivery_slot_instances", "warranty_claims"]) {
    assert.ok(tables.includes(commerceTable), `Missing commerce capability table: ${commerceTable}`);
  }
});

test("background jobs are persisted and leased in MariaDB", async () => {
  const sql = await readFile(jobsMigrationPath, "utf8");
  const tables = [...sql.matchAll(/^CREATE TABLE\s+([a-z0-9_]+)/gim)].map((match) => match[1]);
  const tableEndings = [...sql.matchAll(/^\) ENGINE=InnoDB /gim)];

  assert.deepEqual(tables, ["background_jobs", "background_job_attempts"]);
  assert.equal(tableEndings.length, tables.length);
  assert.match(sql, /claim_token BINARY\(16\)/i);
  assert.match(sql, /lock_expires_at DATETIME\(6\)/i);
  assert.match(sql, /REFERENCES background_jobs \(id\)/i);
});
