import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("block parent foreign key is page-scoped and migration is replay-safe", async () => {
  const baseline = (await readFile(new URL("../migrations/001_init.sql", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const migration = (await readFile(
    new URL("../migrations/023_blocks_parent_page_integrity.sql", import.meta.url),
    "utf8"
  )).replace(/\r\n/g, "\n");

  assert.match(baseline, /CONSTRAINT uq_blocks_id_page UNIQUE \(id, page_id\)/);
  assert.match(
    baseline,
    /CONSTRAINT fk_blocks_parent_page FOREIGN KEY \(parent_block_id, page_id\) REFERENCES blocks\(id, page_id\) ON DELETE CASCADE/
  );
  assert.doesNotMatch(baseline, /FOREIGN KEY \(parent_block_id\) REFERENCES blocks\(id\) ON DELETE CASCADE/);

  const addComposite = migration.indexOf("ADD CONSTRAINT fk_blocks_parent_page");
  const dropLegacy = migration.indexOf("DROP FOREIGN KEY fk_blocks_parent");
  assert.ok(addComposite >= 0 && dropLegacy > addComposite);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_blocks_id_page/);
  assert.match(migration, /information_schema\.TABLE_CONSTRAINTS/);

  const reproduction = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-cross-page-parent-cascade-loss.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));
  assert.equal(reproduction.vulnerability.permanentCrossPageLossReproduced, true);
  assert.equal(reproduction.fixed.permanentCrossPageLossClosed, true);
});
