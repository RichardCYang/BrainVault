# BrainVault final data-integrity deep audit report

- Audit date: 2026-07-30
- Original Git HEAD: `9dabd0133d2488bbc666772154d64407b078b716`
- Branch: `main`
- Original archive: `BrainVault.zip`
- Scope: MariaDB writes, deletion and transactions; page/block hierarchy; Yjs persistence, compaction and materialization; browser recovery; attachment lifecycle; full backup/restore; and migration rerun safety

## 1. Final conclusion

The review found and corrected one new reproducible data-integrity defect.

### BV-DI-2026-07-30-ATT-01 — restore could make a valid attachment file inaccessible through the application

- Severity: **High**
- Trigger: the user restores a damaged or manipulated backup
- Immediate deletion of physical file bytes: no
- Application-level data loss: yes
- Remediation status: complete

Even when attachment bytes, size, CRC32, and SHA-256 in the backup ZIP were all valid, the corresponding `ATTACHMENT` block could contain `metadata` that was `null`, `{}`, double-encoded JSON, or inconsistent with the file. The old restore validator checked attachment block IDs, ZIP paths, and checksums, but did not verify that attachment metadata had the shape required by the download path.

After a successful restore, the old workspace was replaced and the file was imported to disk, but the download API treated it as `Attachment file not found` because `metadata.attachment` could not be interpreted. The bytes remained on the server yet could not be opened or downloaded through BrainVault. A later normal block or page deletion could then clean up the file and remove the remaining recovery opportunity.

No other new Critical or High defect was reproduced that bypassed the existing server SQL, Yjs, attachment, restore, or browser-storage defenses.

## 2. Reproduction

The pre-fix relationship validator and download parser produced:

```json
{
  "currentRestoreRelationChecksAccept": true,
  "attachmentBytesAndDescriptorCanMatch": true,
  "downloadMetadataResult": null,
  "restoredFileBecomesUnavailableThroughDownloadRoute": true,
  "effectiveApplicationLevelDataLossReproduced": true
}
```

The temporary evidence output was intentionally excluded from the reorganized project.

Corrected reproduction command:

```bash
npm run reproduce:backup-attachment-metadata-loss
```

Verified corrected behavior:

- Reject missing metadata before any restore database work.
- Reject double-encoded metadata.
- Reject filename or MIME values that canonicalize differently from the stored source.
- Reject sizes that are not safe integers.
- Reject a mismatch between metadata size and actual file bytes.
- Refuse to export an apparently valid backup when the existing workspace already contains damaged attachment metadata.

## 3. Root cause

`validateManifestRelations()` checked JSON syntax for all block metadata but did not apply structural or semantic validation to `ATTACHMENT` blocks. Attachment relationship validation checked only:

- Equality of attachment-block and attachment-entry ID sets
- `attachments/<blockId>` path
- ZIP entry size, CRC32, and SHA-256

The download path, however, serves a file only when `getAttachmentInfo()` returns a valid `metadata.attachment` object. Restore acceptance and runtime usability therefore had different contracts.

## 4. Correction

### New `src/lib/attachment-metadata-integrity.ts`

The pure attachment-metadata validation and normalization contract is centralized in one module.

- `attachment.originalName` must be a string exactly equal to the canonical filename stored at upload.
- `attachment.mimeType` must be a string exactly equal to the canonical MIME type.
- `attachment.size` must be a non-negative JavaScript safe integer.
- When an expected file size is available, metadata size must match exactly.
- JSON parse failure, a non-object root, and double encoding fail closed.

### `src/lib/attachments.ts`

The existing attachment metadata type, parser, and normalizer are re-exported from the new pure module. Download and rendering behavior remain unchanged while sharing one contract with restore and export.

### `src/lib/data-transfer.ts`

Pre-restore relationship validation now binds every attachment entry to its block metadata:

```text
manifest attachment size
        == metadata.attachment.size
        == staged ZIP entry actual byte count
```

This check runs before ID-conflict detection, file import, user-row locking, or deletion of existing SQL data.

Export also compares the actual staged-file size with database metadata. When the current database is already damaged, the server no longer reports an uncertain backup as successful.

### Reproduction and regression gate

- `scripts/reproduce-backup-attachment-metadata-loss.mjs`
- `tests/backup-attachment-metadata-integrity.node.test.mjs`
- Integration in `scripts/verify-data-loss-guards.mjs`
- Added reproduction command in `package.json`

## 5. Overall audit results

### 5.1 MariaDB atomicity and concurrency

- Major page/block writes and deletions use transactions, `FOR UPDATE`, and version CAS.
- Lock ordering is consistent between per-user attachment locks and page locks.
- Ambiguous commit responses preserve data and trigger rechecks rather than guessing success or failure.
- Permanent deletion verifies page/block version snapshots and collaboration-materialization state.
- MariaDB DDL can implicitly commit, so migration safety relies on rerunnability and intermediate markers rather than transaction rollback. Current key data-transform migrations use that pattern.

No new permanent-loss path was reproduced.

### 5.2 Page and block hierarchy

- Page-parent moves lock the complete owned-page set and reject cycles.
- The block-parent foreign key uses `(parent_block_id, page_id)` and permits only same-page relationships.
- Subtree deletion and reorder validate the complete target versions, parents, and ordering.
- `sort_order` fails closed outside the signed MariaDB `INT` range.

No new cross-page cascade or ordering loss was reproduced.

### 5.3 Yjs collaboration

- The first Yjs document must be semantically identical to SQL authority before entering the durable log.
- Updates are persisted in SQL before client acknowledgement.
- A mismatch between process-local rooms and the durable tip blocks stale-instance append and compaction.
- Snapshot insertion and deletion of old updates occur in the same database transaction.
- Materialization replays the locked durable update log instead of trusting a duplicate browser-submitted body.
- Attachment deletion and replacement inspect unacknowledged recovery from other tabs.

No new permanent collaboration-loss path was reproduced.

### 5.4 Attachment lifecycle

- Final publication uses an exclusive hard-link claim instead of overwrite-capable `rename()`.
- Temporary names are removed only after file and directory synchronization.
- Moved files are retained when the database commit outcome is ambiguous.
- Cleanup rechecks that the block is absent from the database.
- Backup ZIP streaming recalculates CRC32 and SHA-256 over actual bytes.
- The correction extends the same integrity chain to attachment metadata.

### 5.5 Backup and restore

- Export takes a consistent snapshot after locking the owned page set.
- Backup and restore are rejected when Yjs state is not completely materialized into SQL.
- ZIP paths, duplicates, size, CRC32, SHA-256, hierarchy, tags, sharing relationships, and structured metadata are validated.
- The workspace fingerprint is rechecked immediately before restore.
- A restore journal and attachment generation marker recover database-commit and directory-transition outcomes.
- The correction rejects attachment metadata inconsistent with the file before touching the existing workspace.

### 5.6 Browser local recovery

- Direct drafts, Yjs recovery, and transition leases are separated by tab/source.
- Malformed or empty records are not treated as safely absent and overwritten or removed.
- Destructive transitions fail closed when cross-tab Web Locks are unavailable.
- All relevant drafts and recovery copies are inspected before page/block deletion.
- Only acknowledged state is removed under matching generation/revision conditions.

No new permanent-loss path was reproduced.

## 6. Verification results

```text
node --experimental-strip-types --test tests/*.node.test.mjs
48 tests, 48 passed, 0 failed

node scripts/verify-data-loss-guards.mjs
PASS

node --experimental-strip-types scripts/verify-collaboration.mjs
PASS, syntax/source/protocol checks for 163 files

node --experimental-strip-types scripts/reproduce-backup-attachment-metadata-loss.mjs
PASS: vulnerable and fixed states both demonstrated

tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext \
  src/lib/attachment-metadata-integrity.ts
PASS: focused semantic type check
```

The temporary command logs were intentionally excluded from the reorganized deliverable.

## 7. Verification limitations

The environment's internal npm proxy returned `404` for the lockfile request `zod-3.25.76.tgz`, so `npm ci --ignore-scripts` did not complete. The full Vitest suite, formal `tsc` build, and live MariaDB integration tests could not be rerun there.

Instead, 48 dependency-free durability tests, the integrated data-loss verifier, collaboration source/protocol/syntax verification, and the new vulnerability reproducer all passed. The new pure metadata module also passed a focused semantic type check with global TypeScript 5.8.3. Before deployment, run:

```bash
npm ci
npm run check
```

## 8. Original ZIP line-ending corruption and recovery

Compared with the Git objects, files in the uploaded working tree had LF expanded to CRLF, and even binary files such as PNGs contained inserted CR bytes. The `.git` pack and objects were intact, so all tracked files were restored from the original Git `HEAD` blobs before applying the correction.

This was a delivery-archive working-tree integrity problem, not an application-code defect. The final archive includes tracked binaries verified against Git object bytes.

## 9. `.git` preservation

- `.git` was not deleted, initialized, committed, or garbage-collected.
- Immediately before final packaging, only the `.git/index` stat cache updated during audit inspection was restored from the identical original ZIP bytes.
- A full SHA-256 manifest of `.git` is compared with the original.
- The `.git` directory embedded in the final ZIP is extracted and verified against the same manifest.

## 10. Changed files

Modified:

- `src/lib/attachments.ts`
- `src/lib/data-transfer.ts`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- Documentation index

Added:

- `src/lib/attachment-metadata-integrity.ts`
- `tests/backup-attachment-metadata-integrity.node.test.mjs`
- `scripts/reproduce-backup-attachment-metadata-loss.mjs`
- This audit report

Temporary audit output is deliberately excluded from the reorganized project.

## 11. Official references

- MariaDB Server: `START TRANSACTION` / `COMMIT` / `ROLLBACK`
  - https://mariadb.com/docs/server/reference/sql-statements/transactions/start-transaction
- MariaDB Server: SQL statements causing an implicit commit
  - https://mariadb.com/docs/server/reference/sql-statements/transactions/sql-statements-that-cause-an-implicit-commit
- Node.js File System API
  - https://nodejs.org/api/fs.html
- Yjs document updates
  - https://docs.yjs.dev/api/document-updates
