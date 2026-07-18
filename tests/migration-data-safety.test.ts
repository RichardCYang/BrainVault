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
});
