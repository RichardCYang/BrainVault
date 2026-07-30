import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertLosslessBackupBlockMetadata,
  BackupMetadataIntegrityError,
  assertStructuredBlockMetadataIntegrity
} from "../src/lib/structured-metadata-integrity.ts";
import { getTableData } from "../src/lib/table.ts";

function overflowTableMetadata() {
  return {
    table: {
      rows: Array.from({ length: 51 }, (_, index) => [`row-${index + 1}`]),
      headerRow: false,
      headerColumn: false
    }
  };
}

test("a JSON-valid backup can lose structured rows after restore, render, and save", () => {
  const original = overflowTableMetadata();
  const encoded = JSON.stringify(original);

  // This was the complete pre-fix restore check: syntax-valid JSON was accepted.
  assert.deepEqual(JSON.parse(encoded), original);

  // The editor's defensive projection intentionally caps a table at 50 rows.
  const projected = getTableData(original);
  assert.equal(original.table.rows.length, 51);
  assert.equal(projected.rows.length, 50);
  assert.equal(projected.rows.some((row) => row[0] === "row-51"), false);

  // Once the projected state is saved, it is valid and the omitted row is gone permanently.
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("TABLE", { table: projected }));
});

test("backup restore now rejects lossy structured metadata before import", () => {
  const block = {
    id: "block-overflow",
    type: "TABLE",
    metadata: JSON.stringify(overflowTableMetadata())
  };

  assert.throws(
    () => assertLosslessBackupBlockMetadata(block),
    (error) => error instanceof BackupMetadataIntegrityError
      && error.blockId === block.id
      && error.path === "metadata.table.rows"
  );

  assert.doesNotThrow(() => assertLosslessBackupBlockMetadata({
    ...block,
    metadata: JSON.stringify({
      table: {
        rows: Array.from({ length: 50 }, (_, index) => [`row-${index + 1}`]),
        headerRow: false,
        headerColumn: false
      }
    })
  }));
});

test("double-encoded structured backup metadata is rejected instead of restored ambiguously", () => {
  const encodedObject = JSON.stringify({
    table: { rows: [["preserve-me"]], headerRow: false, headerColumn: false }
  });
  const doubleEncoded = JSON.stringify(encodedObject);

  assert.throws(
    () => assertLosslessBackupBlockMetadata({
      id: "block-double-encoded",
      type: "TABLE",
      metadata: doubleEncoded
    }),
    (error) => error instanceof BackupMetadataIntegrityError && error.path === "metadata"
  );
});

test("restore integration runs the lossless guard before any database conflict check", async () => {
  const source = (await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const relationValidationStart = source.indexOf("function validateManifestRelations");
  const relationValidationEnd = source.indexOf("export async function prepareUserDataBackup", relationValidationStart);
  const relationValidation = source.slice(relationValidationStart, relationValidationEnd);

  assert.match(relationValidation, /assertLosslessBackupBlockMetadata\(block\)/);
  assert.ok(
    source.indexOf("validateManifestRelations(manifest)")
      < source.indexOf("await assertNoForeignIdConflicts(userId, manifest)"),
    "backup metadata must be rejected before restore touches database identity checks"
  );
});
