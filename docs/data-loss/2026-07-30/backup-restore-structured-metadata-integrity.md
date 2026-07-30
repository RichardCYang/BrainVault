# BrainVault backup-restore structured-metadata integrity audit and correction report

- Audit date: 2026-07-30 (Asia/Seoul)
- Audited Git HEAD: `a9044cc05463bed8daf14385631f7d389cad57ad`
- Branch: `main`
- Scope: full uploaded working tree, preserved `.git`, MariaDB storage, Yjs durability, attachments, backup/restore, and browser recovery
- `.git` regular-file count at audit start: 28
- Initial `.git` manifest SHA-256: `1b4e2af32b04862634c25f2d94fb295c627a632686de5da1c6e01ba1c2d275c2`

## 1. Conclusion

This independent re-audit reproduced and corrected one new **High-severity integrity defect that could silently and permanently delete part of a structured block after a successful backup restore and ordinary subsequent editing**.

### BV-DI-2026-07-30-RESTORE-METADATA

- Impact: High
- Trigger: an older, manually created, or partially damaged backup contains TABLE, KANBAN, DATABASE, BOOKMARK, or AI_CHAT metadata that exceeds editor limits or is double-encoded
- Immediate restore result: the original metadata string reaches the database, so the excess data is not deleted immediately
- Deferred loss: the editor projects the restored state down to supported limits, and a later ordinary edit/save writes only that projection, removing data that was not visible in the editor
- Missing defense: restore validation proved only that `JSON.parse()` succeeded; it did not prove conformance to the application schema or lossless editability

The deterministic reproduction used a syntactically valid TABLE backup with 51 rows. Restore validation accepted it, the editor projection reduced it to 50 rows, and the 50-row projection was accepted as a normal save input. The 51st row could therefore be lost permanently on the next save.

After the correction, restore validates the serialized metadata with the existing server-side lossless-integrity checker. Lossy input fails closed with `INVALID_DATA_BACKUP` before workspace deletion, database conflict checking, or attachment-generation replacement.

## 2. Root-cause analysis

The previous metadata check in `validateManifestRelations()` was effectively:

```text
metadata === null
  or
JSON.parse(metadata) succeeds
```

That proves JSON syntax only. The editor and server renderers apply the following structured-data limits and normalization rules:

- TABLE: at most 50 rows, 20 columns, and 4,000 characters per cell
- KANBAN: at most 12 columns and 50 cards per column, with tag/title/description limits
- DATABASE: at most 20 properties, 200 rows, and 12 views, plus limits and reference cleanup for options, filters, and sorts
- BOOKMARK: at most 50 items, with URL canonicalization, duplicate removal, and string limits
- AI_CHAT: question up to 8,000 characters, answer up to 12,000 characters, and provider/model/date format restrictions

Those rules are reasonable for safely projecting damaged input into the UI. They are not safe as an authoritative restore transformation. When restored source metadata exceeds the projection, the next edit can send only the visible projection. The existing save-side lossless guard then sees a valid projection and cannot know that data was omitted from the restored original.

The review also found a double-encoding gap. If a restore helper first passed a `JSON.parse()` result into the structured validator, a JSON string of the form `"{...}"` could be decoded twice and accepted. The actual editor and mapper decode the stored representation only once, creating a representation mismatch. The final correction passes the **serialized string from the backup itself**, not a previously decoded value, into structured validation.

## 3. Correction

### `src/lib/structured-metadata-integrity.ts`

- Added `BackupMetadataIntegrityError`.
- Added `assertLosslessBackupBlockMetadata()`.
- Validates JSON syntax for all metadata.
- Passes the serialized backup value directly to `assertStructuredBlockMetadataIntegrity()` for structured block types.
- Rejects limit overflow, lossy normalization, relationship-reference errors, and double encoding with a precise path and reason.
- Leaves valid metadata unchanged and does not reserialize it.

### `src/lib/data-transfer.ts`

- Replaced the simple `JSON.parse()` check in `validateManifestRelations()`.
- Applies `assertLosslessBackupBlockMetadata()` to every block.
- Returns `INVALID_DATA_BACKUP` with the lossy metadata path and reason on failure.
- Runs this validation before:
  - `assertNoForeignIdConflicts()`
  - locking the user's workspace
  - deleting existing pages
  - replacing the attachment generation

A single lossy block therefore cannot trigger a partial restore that first replaces an otherwise healthy workspace.

### Reproduction and regression assets

- `scripts/reproduce-backup-metadata-loss.mjs`
- `tests/backup-metadata-integrity.node.test.mjs`
- `reproduce:backup-metadata-loss` in `package.json`
- Integrated guard in `scripts/verify-data-loss-guards.mjs`

## 4. Reproduction results

Run:

```bash
npm run reproduce:backup-metadata-loss
```

Verified vulnerable state:

```json
{
  "jsonSyntaxAccepted": true,
  "originalRows": 51,
  "rowsAfterEditorProjection": 50,
  "silentlyLostRowsAfterNextSave": 1,
  "projectedSaveWouldBeAccepted": true,
  "permanentStructuredDataLossReproduced": true
}
```

Verified corrected state:

```json
{
  "rejectedBeforeRestoreDatabaseWork": true,
  "rejectedPath": "metadata.table.rows",
  "doubleEncodedRejected": true,
  "lossClosed": true
}
```

A TABLE with exactly 50 rows remains accepted unchanged. The correction does not transform or arbitrarily shorten valid backups; it fails closed only for backups that cannot be edited losslessly.

## 5. Full deep-review summary

### MariaDB transactions and hierarchical deletion

- Major mutations use InnoDB transactions and row locks.
- Permanent page/block deletion occurs after subtree-version snapshots and locking.
- The block-parent foreign key is page-scoped through `(parent_block_id, page_id)`, preventing cross-page cascades.
- An ambiguous commit outcome does not cause eager file deletion.

No additional permanent-loss path was reproduced in this area.

### Yjs collaboration

- A Yjs update enters the durable SQL log before broadcast or acknowledgement.
- Initial-document bootstrap must be semantically identical to the current relational document.
- Materialization reconstructs from the locked durable update log rather than trusting a browser snapshot.
- Snapshot insertion and deletion of old updates occur in the same transaction.
- Protections exist for multi-instance stale rooms, materialization-checkpoint provenance, and cross-tab recovery before collaboration deletion.

The collaboration verifier passed wiring, protocol, and syntax checks for 160 files in the corrected tree.

### Attachments

- Final file publication uses an exclusive hard-link claim rather than an overwrite-capable rename.
- Files and directories are `fsync`ed.
- Files are preserved conservatively when the database outcome is ambiguous.
- Cleanup rechecks database existence under the owner lock.
- Backup/restore verifies size, CRC32, SHA-256, and the attachment generation journal.

No new attachment-byte-loss path was reproduced in this scope.

### Browser recovery and transitions

- Live mutation is not exposed before the draft or recovery copy is durably written.
- Destructive page/block actions inspect unacknowledged recovery from other tabs.
- Transition leases, source scoping, and fail-closed malformed-storage checks remain in place.

No additional permanent-loss path was reproduced in this area.

## 6. Verification results

Passed:

- `node --experimental-strip-types --test tests/*.node.test.mjs`
  - All 43 durability tests passed, including four new cases.
- `node scripts/verify-data-loss-guards.mjs`
  - Passed, including vulnerable and fixed backup-metadata reproduction.
- `node --experimental-strip-types scripts/verify-collaboration.mjs`
  - Passed checks for 160 files.
- `node scripts/lockfile-registry.mjs`
  - Passed allow-list checks for 347 resolved URLs.
- Isolated TypeScript check for the modified integrity module
  - Passed `tsc --noEmit` with an empty external type root.
- Syntax checks for the new reproduction script and integrated verifier
  - Passed.

## 7. Environment limitations

The sandbox forced `NPM_CONFIG_REGISTRY` to an internal Artifactory that took precedence over the project `.npmrc`. That mirror returned `404` for `zod@3.25.76`, so `npm ci --ignore-scripts` could not complete. The partial `node_modules` created by npm was removed from the final artifact.

The following could not be completed in that environment:

- Full `tsc -p tsconfig.json` build
- Full Vitest unit/integration suite
- Integration and fault-injection tests against a live MariaDB process

The logs indicated missing or empty dependency files such as `@types/node`, `vitest`, `mariadb`, and `zod`, not a source-code failure. Run the final gate in a deployment environment with a normal npm registry and MariaDB:

```bash
npm ci
npm run check
```

## 8. `.git` preservation

- `.git` was not deleted, initialized, committed, garbage-collected, or checked out.
- The directory contained 28 regular files both before and after the correction.
- The recursive file manifest SHA-256 remained `1b4e2af32b04862634c25f2d94fb295c627a632686de5da1c6e01ba1c2d275c2`.
- The packaged ZIP is subject to a final byte-level comparison of its embedded `.git` files.

## 9. Changed files

Modified:

- `src/lib/structured-metadata-integrity.ts`
- `src/lib/data-transfer.ts`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- `docs/README.md`

Added:

- `scripts/reproduce-backup-metadata-loss.mjs`
- `tests/backup-metadata-integrity.node.test.mjs`
- This audit report
- Related temporary verification output, intentionally excluded from the reorganized deliverable

## 10. Official sources used for cross-checking

- MariaDB JSON Data Type / `JSON_VALID`: JSON syntax validation and application-level structural validation are separate layers.
- MariaDB Transactions / `START TRANSACTION` / `COMMIT` / `ROLLBACK`: atomicity baseline for workspace replacement.
- Yjs Document Updates: commutative, associative, and idempotent update properties used to review the durable update log.
- MDN IndexedDB durability guidance: browser-local recovery must not be treated as equivalent to durable server persistence.
