import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertLosslessBackupBlockMetadata,
  BackupMetadataIntegrityError,
  assertStructuredBlockMetadataIntegrity
} from "../src/lib/structured-metadata-integrity.ts";
import { getTableData } from "../src/lib/table.ts";

const original = {
  table: {
    rows: Array.from({ length: 51 }, (_, index) => [`row-${index + 1}`]),
    headerRow: false,
    headerColumn: false
  }
};
const encoded = JSON.stringify(original);
const oldRestoreAccepted = JSON.parse(encoded);
const projected = getTableData(oldRestoreAccepted);
assert.equal(oldRestoreAccepted.table.rows.length, 51);
assert.equal(projected.rows.length, 50);
assert.equal(projected.rows.some((row) => row[0] === "row-51"), false);
assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("TABLE", { table: projected }));

let rejectedPath = "";
try {
  assertLosslessBackupBlockMetadata({
    id: "block-overflow",
    type: "TABLE",
    metadata: encoded
  });
} catch (error) {
  if (!(error instanceof BackupMetadataIntegrityError)) throw error;
  rejectedPath = error.path;
}
assert.equal(rejectedPath, "metadata.table.rows");

let doubleEncodedRejected = false;
try {
  assertLosslessBackupBlockMetadata({
    id: "block-double-encoded",
    type: "TABLE",
    metadata: JSON.stringify(JSON.stringify({ table: { rows: [["preserve-me"]] } }))
  });
} catch (error) {
  if (!(error instanceof BackupMetadataIntegrityError)) throw error;
  doubleEncodedRejected = error.path === "metadata";
}
assert.equal(doubleEncodedRejected, true);

const source = (await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const guardIndex = source.indexOf("validateManifestRelations(manifest)");
const firstDatabaseCheckIndex = source.indexOf("await assertNoForeignIdConflicts(userId, manifest)");
assert.ok(guardIndex >= 0 && firstDatabaseCheckIndex > guardIndex);
assert.ok(source.includes("assertLosslessBackupBlockMetadata(block)"));

console.log(JSON.stringify({
  vulnerability: {
    jsonSyntaxAccepted: true,
    originalRows: oldRestoreAccepted.table.rows.length,
    rowsAfterEditorProjection: projected.rows.length,
    silentlyLostRowsAfterNextSave: oldRestoreAccepted.table.rows.length - projected.rows.length,
    projectedSaveWouldBeAccepted: true,
    permanentStructuredDataLossReproduced: true
  },
  fixed: {
    rejectedBeforeRestoreDatabaseWork: true,
    rejectedPath,
    doubleEncodedRejected,
    lossClosed: true
  }
}, null, 2));
