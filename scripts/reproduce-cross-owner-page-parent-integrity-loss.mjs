import { readFileSync } from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const baseline = readFileSync(new URL("../migrations/001_init.sql", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");
const migration = readFileSync(
  new URL("../migrations/064_page_parent_owner_integrity.sql", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

const crossOwnerRows = [
  { id: "page-a", ownerId: "user-a", parentPageId: null },
  { id: "page-b", ownerId: "user-b", parentPageId: "page-a" }
];

function acceptsLegacyParentForeignKey(rows) {
  const ids = new Set(rows.map((row) => row.id));
  return rows.every((row) => row.parentPageId === null || ids.has(row.parentPageId));
}

function acceptsOwnerScopedParentForeignKey(rows) {
  const keys = new Set(rows.map((row) => `${row.id}\u0000${row.ownerId}`));
  return rows.every((row) =>
    row.parentPageId === null || keys.has(`${row.parentPageId}\u0000${row.ownerId}`)
  );
}

function legacyDeleteSetNull(rows, parentId) {
  return rows
    .filter((row) => row.id !== parentId)
    .map((row) => row.parentPageId === parentId
      ? { ...row, parentPageId: null }
      : { ...row });
}

function ownerScopedCascadeDelete(rows, parentId, ownerId) {
  const deleted = new Set([`${parentId}\u0000${ownerId}`]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const key = `${row.id}\u0000${row.ownerId}`;
      const parentKey = row.parentPageId === null
        ? null
        : `${row.parentPageId}\u0000${row.ownerId}`;
      if (parentKey && deleted.has(parentKey) && !deleted.has(key)) {
        deleted.add(key);
        changed = true;
      }
    }
  }
  return deleted;
}

const legacyAccepted = acceptsLegacyParentForeignKey(crossOwnerRows);
const legacyAfterDelete = legacyDeleteSetNull(crossOwnerRows, "page-a");
const unrelatedPageWasModified =
  legacyAfterDelete.find((row) => row.id === "page-b")?.parentPageId === null;
const fixedRejected = !acceptsOwnerScopedParentForeignKey(crossOwnerRows);

const sameOwnerRows = [
  { id: "parent-a", ownerId: "user-a", parentPageId: null },
  { id: "child-a", ownerId: "user-a", parentPageId: "parent-a" }
];
const validSameOwnerAccepted = acceptsOwnerScopedParentForeignKey(sameOwnerRows);
const sameOwnerCascade = ownerScopedCascadeDelete(sameOwnerRows, "parent-a", "user-a");
const validSameOwnerSubtreeCascadePreserved = sameOwnerCascade.has("child-a\u0000user-a");

const baselineUsesOwnerScopedParentKey =
  baseline.includes("CONSTRAINT uq_pages_id_owner UNIQUE (id, owner_id)")
  && baseline.includes(
    "FOREIGN KEY (parent_page_id, owner_id) REFERENCES pages(id, owner_id) ON DELETE CASCADE"
  )
  && !baseline.includes(
    "FOREIGN KEY (parent_page_id) REFERENCES pages(id) ON DELETE SET NULL"
  );

const atomicReplacement = migration.includes(
  "ALTER TABLE pages DROP FOREIGN KEY fk_pages_parent, ADD CONSTRAINT fk_pages_parent_owner FOREIGN KEY (parent_page_id, owner_id) REFERENCES pages(id, owner_id) ON DELETE CASCADE"
);
const migrationIsReplaySafe =
  migration.includes("information_schema.TABLE_CONSTRAINTS")
  && migration.includes("CONSTRAINT_NAME = 'fk_pages_parent_owner'")
  && migration.includes("CONSTRAINT_NAME = 'fk_pages_parent'")
  && migration.includes("PREPARE brainvault_replace_page_parent_fk_statement");
const migrationDoesNotSilentlyRewriteHierarchy =
  !/\bUPDATE\s+pages\b/i.test(migration)
  && !/\bDELETE\s+FROM\s+pages\b/i.test(migration);

const report = {
  vulnerability: {
    legacySchemaAcceptedCrossOwnerParent: legacyAccepted,
    deletingParentModifiedOtherOwnersPage: unrelatedPageWasModified,
    crossOwnerHierarchyModificationReproduced: legacyAccepted && unrelatedPageWasModified
  },
  fixed: {
    baselineUsesOwnerScopedParentKey,
    atomicLegacyFkReplacement: atomicReplacement,
    migrationIsReplaySafe,
    migrationDoesNotSilentlyRewriteHierarchy,
    crossOwnerParentRejected: fixedRejected,
    validSameOwnerHierarchyAccepted: validSameOwnerAccepted,
    validSameOwnerSubtreeCascadePreserved,
    crossOwnerHierarchyModificationClosed:
      baselineUsesOwnerScopedParentKey
      && atomicReplacement
      && migrationIsReplaySafe
      && migrationDoesNotSilentlyRewriteHierarchy
      && fixedRejected
      && validSameOwnerAccepted
      && validSameOwnerSubtreeCascadePreserved
  }
};

assert(
  report.vulnerability.crossOwnerHierarchyModificationReproduced,
  "Legacy cross-owner page-parent modification was not reproduced"
);
assert(
  report.fixed.crossOwnerHierarchyModificationClosed,
  "Owner-scoped page-parent integrity fix is incomplete"
);
console.log(JSON.stringify(report, null, 2));
