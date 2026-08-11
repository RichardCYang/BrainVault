import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { blockTypeSchema } from "../src/utils/schemas.js";

const migrationsDir = path.resolve(process.cwd(), "migrations");

function migrationFiles() {
  return fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
}

function enumValues(sql: string) {
  const match = sql.match(/(?:type\s+|MODIFY\s+COLUMN\s+type\s+)ENUM\s*\(([^)]*)\)/i);
  if (!match) {
    return null;
  }

  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

describe("migration replay data safety", () => {
  it("never narrows the blocks.type enum in a replayable migration", () => {
    const expected = [...blockTypeSchema.options];
    const enumMigrations = migrationFiles()
      .map((name) => ({
        name,
        sql: fs.readFileSync(path.join(migrationsDir, name), "utf8")
      }))
      .filter(({ sql }) => /\b(?:type\s+|MODIFY\s+COLUMN\s+type\s+)ENUM\s*\(/i.test(sql));

    expect(enumMigrations.length).toBeGreaterThan(1);
    for (const migration of enumMigrations) {
      expect(enumValues(migration.sql), migration.name).toEqual(expected);
    }
  });

  it("runs SQL-level PREPARE through the connector text protocol", () => {
    const schemaSource = fs.readFileSync(path.resolve(process.cwd(), "src/lib/schema.ts"), "utf8");
    const migration = fs.readFileSync(
      path.join(migrationsDir, "023_blocks_parent_page_integrity.sql"),
      "utf8"
    );

    expect(migration).toMatch(/\bPREPARE\s+brainvault_add_parent_page_fk_statement/i);
    expect(schemaSource).toContain("await client.executeText(statement);");
    expect(schemaSource).not.toContain("await client.execute(statement);");
  });

  it("keeps a composite index for the immutable page-list scan", () => {
    const baseline = fs.readFileSync(path.join(migrationsDir, "001_init.sql"), "utf8");
    const migration = fs.readFileSync(
      path.join(migrationsDir, "017_stable_page_list_pagination.sql"),
      "utf8"
    );

    for (const sql of [baseline, migration]) {
      expect(sql).toMatch(
        /idx_pages_owner_archived_created[\s\S]*pages\s*\(owner_id,\s*is_archived,\s*created_at,\s*id\)/i
      );
    }
  });

  it("adds a non-destructive account authentication generation", () => {
    const sql = fs.readFileSync(
      path.join(migrationsDir, "024_auth_session_revocation.sql"),
      "utf8"
    );

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS auth_version BIGINT UNSIGNED NOT NULL DEFAULT 1/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+users/i);
  });

  it("adds non-destructive persisted account login backoff", () => {
    const baseline = fs.readFileSync(path.join(migrationsDir, "001_init.sql"), "utf8");
    const sql = fs.readFileSync(
      path.join(migrationsDir, "030_account_login_lockout.sql"),
      "utf8"
    );

    for (const source of [baseline, sql]) {
      expect(source).toMatch(/failed_login_attempts INT UNSIGNED NOT NULL DEFAULT 0/i);
      expect(source).toMatch(/last_failed_login_at DATETIME\(3\) NULL/i);
      expect(source).toMatch(/login_locked_until DATETIME\(3\) NULL/i);
    }
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/i);
  });

  it("extends login history with a distinct locked outcome without deleting records", () => {
    const sql = fs.readFileSync(
      path.join(migrationsDir, "033_login_history_locked_outcome.sql"),
      "utf8"
    );
    expect(sql).toMatch(/ENUM\('SUCCESS', 'FAILURE', 'LOCKED'\)/i);
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/i);
  });

  it("adds non-destructive GeoIP metadata to login history", () => {
    const sql = fs.readFileSync(
      path.join(migrationsDir, "044_login_history_country.sql"),
      "utf8"
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS country_code CHAR\(2\) NULL/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS country_dataset_updated_at DATETIME\(3\) NULL/i);
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/i);
  });

  it("adds a non-destructive collaboration document epoch fence", () => {
    const sql = fs.readFileSync(
      path.join(migrationsDir, "021_collaboration_document_epoch.sql"),
      "utf8"
    );

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS document_epoch VARCHAR\(64\) NULL/i);
    expect(sql).toMatch(
      /UPDATE\s+page_collaboration_state[\s\S]*WHERE document_epoch IS NULL OR document_epoch = ''/i
    );
    expect(sql).toMatch(/MODIFY COLUMN document_epoch VARCHAR\(64\) NOT NULL/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+page_(?:collaboration_state|yjs_updates)/i);
  });

  it("marks legacy collaboration checkpoints as untrusted without deleting durable history", () => {
    const sql = fs.readFileSync(
      path.join(migrationsDir, "022_server_authoritative_collaboration_materialization.sql"),
      "utf8"
    );

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS materialization_version SMALLINT UNSIGNED NOT NULL DEFAULT 0/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+page_(?:collaboration_state|yjs_updates)/i);
    expect(sql).not.toMatch(/UPDATE\s+page_collaboration_state/i);
  });

  it("persists and consumes a crash-safe marker for the legacy collection backfill", () => {
    const sql = fs.readFileSync(
      path.join(migrationsDir, "009_pages_collection_kind.sql"),
      "utf8"
    );

    const marker = "009_pages_collection_kind.sql:legacy-backfill-required";
    const markerInsertIndex = sql.indexOf("INSERT IGNORE INTO schema_migrations");
    const alterIndex = sql.indexOf("ALTER TABLE pages");
    const updateIndex = sql.indexOf("UPDATE pages");
    const markerDeleteIndex = sql.indexOf("DELETE FROM schema_migrations");

    expect(markerInsertIndex).toBeGreaterThanOrEqual(0);
    expect(markerInsertIndex).toBeLessThan(alterIndex);
    expect(alterIndex).toBeLessThan(updateIndex);
    expect(updateIndex).toBeLessThan(markerDeleteIndex);
    expect(sql).toContain(marker);
    expect(sql).toMatch(/INSERT IGNORE[\s\S]*WHERE NOT EXISTS[\s\S]*is_collection/i);
    expect(sql).toMatch(/UPDATE\s+pages[\s\S]*WHERE EXISTS[\s\S]*schema_migrations/i);
  });
  it("adds durable per-user navigation collapse preferences with cascade cleanup", () => {
    const baseline = fs.readFileSync(path.join(migrationsDir, "001_init.sql"), "utf8");
    const sql = fs.readFileSync(
      path.join(migrationsDir, "043_navigation_collapse_preferences.sql"),
      "utf8"
    );

    for (const source of [baseline, sql]) {
      expect(source).toMatch(/CREATE TABLE IF NOT EXISTS user_navigation_collapsed_pages/i);
      expect(source).toMatch(/PRIMARY KEY \(user_id, page_id\)/i);
      expect(source).toMatch(/FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/i);
      expect(source).toMatch(/FOREIGN KEY \(page_id\) REFERENCES pages\(id\) ON DELETE CASCADE/i);
    }
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE)\b/i);
  });

  it("adds non-destructive per-user sidebar page ordering without touching note rows", () => {
    const baseline = fs.readFileSync(path.join(migrationsDir, "001_init.sql"), "utf8");
    const sql = fs.readFileSync(
      path.join(migrationsDir, "049_navigation_page_order.sql"),
      "utf8"
    );

    for (const source of [baseline, sql]) {
      expect(source).toMatch(/CREATE TABLE IF NOT EXISTS user_navigation_page_order/i);
      expect(source).toMatch(/PRIMARY KEY \(user_id, page_id\)/i);
      expect(source).toMatch(/sort_order INT UNSIGNED NOT NULL/i);
      expect(source).toMatch(/FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/i);
      expect(source).toMatch(/FOREIGN KEY \(page_id\) REFERENCES pages\(id\) ON DELETE CASCADE/i);
    }
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE|UPDATE\s+pages|UPDATE\s+blocks)\b/i);
  });

  it("widens page icon storage without deleting existing data", () => {
    const sql = fs.readFileSync(
      path.join(migrationsDir, "026_page_custom_icons.sql"),
      "utf8"
    );

    expect(sql).toMatch(/ALTER TABLE users[\s\S]*default_collection_icon MEDIUMTEXT NULL/i);
    expect(sql).toMatch(/ALTER TABLE pages[\s\S]*icon MEDIUMTEXT NULL/i);
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/i);
  });

});
