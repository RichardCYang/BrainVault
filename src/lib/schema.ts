import fs from "node:fs";
import path from "node:path";
import mariadb, { type Pool } from "mariadb";
import { env } from "../config/env.js";
import { parseDatabaseUrl, databaseOptionsWithSchema } from "./database-url.js";
import { createClient, db, strictTransactionalSqlMode, transaction, type DbClient } from "./db.js";

const migrationsDir = path.resolve(process.cwd(), "migrations");
const baselineMigration = "001_init.sql";

const schemaMigrationsTableSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id VARCHAR(255) PRIMARY KEY,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

export function splitSqlStatements(sql: string) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function ensureMigrationTable(client: DbClient = db) {
  await client.execute(schemaMigrationsTableSql);
}

function listMigrationFiles() {
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  return fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
}

async function executeSqlFile(client: DbClient, filename: string) {
  const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
  for (const statement of splitSqlStatements(sql)) {
    // Migration files are trusted SQL scripts and may include SQL-level
    // PREPARE/EXECUTE/DEALLOCATE statements. Using execute() here would ask
    // the connector to prepare PREPARE itself and fail with ER_UNSUPPORTED_PS.
    await client.executeText(statement);
  }
}

async function getAppliedMigrations(client: DbClient) {
  const rows = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
  return new Set(rows.map((row) => row.id));
}


async function tableExists(client: DbClient, tableName: string) {
  const row = await client.queryOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [tableName]
  );
  return Number(row?.count ?? 0) > 0;
}

async function columnExists(client: DbClient, tableName: string, columnName: string) {
  const row = await client.queryOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [tableName, columnName]
  );
  return Number(row?.count ?? 0) > 0;
}

async function reconcileUserIdentifierColumn(client: DbClient) {
  if (!(await tableExists(client, "users"))) {
    return;
  }

  if (!(await columnExists(client, "users", "username"))) {
    await client.execute("ALTER TABLE users ADD COLUMN username VARCHAR(50)");
  }

  if (await columnExists(client, "users", "email")) {
    await client.execute(
      "UPDATE users SET username = 'demo' WHERE username IS NULL AND email = 'demo@brainvault.local'"
    );

    // Legacy BrainVault versions used users.email as a required login field.
    // Current versions authenticate with username, so keep old data readable but
    // make the old column nullable to avoid ER_NO_DEFAULT_FOR_FIELD on signup.
    await client.execute("ALTER TABLE users MODIFY COLUMN email VARCHAR(255) NULL DEFAULT NULL");
  }

  await client.execute(
    "UPDATE users SET username = LOWER(CONCAT('user_', REPLACE(SUBSTRING(id, 1, 12), '-', ''))) WHERE username IS NULL"
  );
  await client.execute("ALTER TABLE users MODIFY username VARCHAR(50) NOT NULL");
  await client.execute("ALTER TABLE users ADD UNIQUE INDEX IF NOT EXISTS uq_users_username (username)");
}

export type MigrationSummary = {
  baselineReconciled: boolean;
  applied: string[];
  skipped: string[];
};

async function reconcileBaselineSchema(database: DbClient, source?: Pool) {
  const baselinePath = path.join(migrationsDir, baselineMigration);
  if (!fs.existsSync(baselinePath)) {
    await ensureMigrationTable(database);
    return false;
  }

  await transaction(async (client) => {
    await executeSqlFile(client, baselineMigration);
    await client.execute("INSERT IGNORE INTO schema_migrations (id) VALUES (?)", [baselineMigration]);
  }, source);

  return true;
}

export async function ensureSchema(): Promise<MigrationSummary> {
  if (!env.MARIADB_ADMIN_URL) return migrate(db);
  const runtime = parseDatabaseUrl(env.DATABASE_URL, { requireDatabase: true });
  const admin = parseDatabaseUrl(env.MARIADB_ADMIN_URL, { requireDatabase: false });
  const pool = mariadb.createPool({
    ...databaseOptionsWithSchema({ ...admin, database: runtime.database }),
    connectionLimit: 1, bigIntAsNumber: true, checkNumberRange: true,
    initSql: strictTransactionalSqlMode
  });
  try { return await migrate(createClient(pool), pool); }
  finally { await pool.end(); }
}

async function migrate(database: DbClient, source?: Pool): Promise<MigrationSummary> {
  const baselineReconciled = await reconcileBaselineSchema(database, source);
  await ensureMigrationTable(database);
  await reconcileUserIdentifierColumn(database);

  const applied = await getAppliedMigrations(database);
  const files = listMigrationFiles();
  const appliedNow: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (applied.has(file)) {
      skipped.push(file);
      continue;
    }

    await transaction(async (client) => {
      await executeSqlFile(client, file);
      await client.execute("INSERT IGNORE INTO schema_migrations (id) VALUES (?)", [file]);
    }, source);

    appliedNow.push(file);
  }

  return { baselineReconciled, applied: appliedNow, skipped };
}
