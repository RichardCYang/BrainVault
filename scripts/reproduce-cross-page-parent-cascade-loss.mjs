import { readFileSync } from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const baseline = readFileSync(new URL("../migrations/001_init.sql", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");
const migration = readFileSync(
  new URL("../migrations/023_blocks_parent_page_integrity.sql", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

const seed = [
  { id: "parent-a", pageId: "page-a", parentBlockId: null },
  { id: "child-b", pageId: "page-b", parentBlockId: "parent-a" }
];

function acceptsSingleColumnParentForeignKey(rows) {
  const ids = new Set(rows.map((row) => row.id));
  return rows.every((row) => row.parentBlockId === null || ids.has(row.parentBlockId));
}

function acceptsCompositeParentForeignKey(rows) {
  const keys = new Set(rows.map((row) => `${row.id}\u0000${row.pageId}`));
  return rows.every((row) =>
    row.parentBlockId === null || keys.has(`${row.parentBlockId}\u0000${row.pageId}`)
  );
}

function cascadeDelete(rows, rootId) {
  const deleted = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.parentBlockId && deleted.has(row.parentBlockId) && !deleted.has(row.id)) {
        deleted.add(row.id);
        changed = true;
      }
    }
  }
  return deleted;
}

const legacyAccepted = acceptsSingleColumnParentForeignKey(seed);
const legacyDeleted = cascadeDelete(seed, "parent-a");
const fixedRejected = !acceptsCompositeParentForeignKey(seed);
const validSamePageRows = [
  { id: "parent-a", pageId: "page-a", parentBlockId: null },
  { id: "child-a", pageId: "page-a", parentBlockId: "parent-a" }
];
const validSamePageAccepted = acceptsCompositeParentForeignKey(validSamePageRows);
const validSamePageCascadePreserved = cascadeDelete(validSamePageRows, "parent-a").has("child-a");

const baselineUsesCompositeParentKey =
  baseline.includes("CONSTRAINT uq_blocks_id_page UNIQUE (id, page_id)")
  && baseline.includes(
    "CONSTRAINT fk_blocks_parent_page FOREIGN KEY (parent_block_id, page_id) REFERENCES blocks(id, page_id) ON DELETE CASCADE"
  )
  && !baseline.includes("FOREIGN KEY (parent_block_id) REFERENCES blocks(id) ON DELETE CASCADE");
const addIndex = migration.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS uq_blocks_id_page");
const addComposite = migration.indexOf("ADD CONSTRAINT fk_blocks_parent_page");
const dropLegacy = migration.indexOf("DROP FOREIGN KEY fk_blocks_parent");
const migrationStrengthensBeforeDropping = addIndex >= 0 && addComposite > addIndex && dropLegacy > addComposite;
const migrationIsReplaySafe =
  migration.includes("information_schema.TABLE_CONSTRAINTS")
  && migration.includes("PREPARE brainvault_add_parent_page_fk_statement")
  && migration.includes("PREPARE brainvault_drop_legacy_parent_fk_statement");

const report = {
  vulnerability: {
    legacySchemaAcceptedCrossPageParent: legacyAccepted,
    deletingParentCascadedOtherPageChild: legacyDeleted.has("child-b"),
    permanentCrossPageLossReproduced: legacyAccepted && legacyDeleted.has("child-b")
  },
  fixed: {
    baselineUsesCompositeParentKey,
    migrationStrengthensBeforeDropping,
    migrationIsReplaySafe,
    crossPageParentRejected: fixedRejected,
    validSamePageHierarchyAccepted: validSamePageAccepted,
    validSamePageCascadePreserved,
    permanentCrossPageLossClosed:
      baselineUsesCompositeParentKey
      && migrationStrengthensBeforeDropping
      && migrationIsReplaySafe
      && fixedRejected
      && validSamePageAccepted
      && validSamePageCascadePreserved
  }
};

assert(report.vulnerability.permanentCrossPageLossReproduced, "Legacy cross-page cascade was not reproduced");
assert(report.fixed.permanentCrossPageLossClosed, "Composite parent-page integrity fix is incomplete");
console.log(JSON.stringify(report, null, 2));
