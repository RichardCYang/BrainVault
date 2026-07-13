import fs from "node:fs";
import path from "node:path";
import { db, transaction, type DbClient } from "./db.js";

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
    await client.execute(statement);
  }
}

async function getAppliedMigrations() {
  const rows = await db.query<{ id: string }>("SELECT id FROM schema_migrations");
  return new Set(rows.map((row) => row.id));
}


async function tableExists(tableName: string) {
  const row = await db.queryOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [tableName]
  );
  return Number(row?.count ?? 0) > 0;
}

async function columnExists(tableName: string, columnName: string) {
  const row = await db.queryOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [tableName, columnName]
  );
  return Number(row?.count ?? 0) > 0;
}

async function reconcileUserIdentifierColumn() {
  if (!(await tableExists("users"))) {
    return;
  }

  if (!(await columnExists("users", "username"))) {
    await db.execute("ALTER TABLE users ADD COLUMN username VARCHAR(50)");
  }

  if (await columnExists("users", "email")) {
    await db.execute(
      "UPDATE users SET username = 'demo' WHERE username IS NULL AND email = 'demo@brainvault.local'"
    );

    // Legacy BrainVault versions used users.email as a required login field.
    // Current versions authenticate with username, so keep old data readable but
    // make the old column nullable to avoid ER_NO_DEFAULT_FOR_FIELD on signup.
    await db.execute("ALTER TABLE users MODIFY COLUMN email VARCHAR(255) NULL DEFAULT NULL");
  }

  await db.execute(
    "UPDATE users SET username = LOWER(CONCAT('user_', REPLACE(SUBSTRING(id, 1, 12), '-', ''))) WHERE username IS NULL"
  );
  await db.execute("ALTER TABLE users MODIFY username VARCHAR(50) NOT NULL");
  await db.execute("ALTER TABLE users ADD UNIQUE INDEX IF NOT EXISTS uq_users_username (username)");
}

export type MigrationSummary = {
  baselineReconciled: boolean;
  applied: string[];
  skipped: string[];
};

async function reconcileBaselineSchema() {
  const baselinePath = path.join(migrationsDir, baselineMigration);
  if (!fs.existsSync(baselinePath)) {
    await ensureMigrationTable();
    return false;
  }

  await transaction(async (client) => {
    await executeSqlFile(client, baselineMigration);
    await client.execute("INSERT IGNORE INTO schema_migrations (id) VALUES (?)", [baselineMigration]);
  });

  return true;
}

export async function ensureSchema(): Promise<MigrationSummary> {
  const baselineReconciled = await reconcileBaselineSchema();
  await ensureMigrationTable();
  await reconcileUserIdentifierColumn();

  const applied = await getAppliedMigrations();
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
    });

    appliedNow.push(file);
  }

  return { baselineReconciled, applied: appliedNow, skipped };
}
