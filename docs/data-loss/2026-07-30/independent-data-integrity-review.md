# BrainVault independent data-integrity deep audit report

- Audit date: 2026-07-30
- Audited Git HEAD: `5e4bf4985a7ab0022ab6803858fc08af66640921`
- Branch: `main`
- Scope: complete attached source, migrations, browser recovery stores, Yjs collaboration server, attachment storage, backup/restore, and verification/reproduction scripts
- Baseline `.git` manifest SHA-256: `9723dd233f0a9d8b1394bce225f62b04a81f1c12731c6a448e74ef450da9fec9`

> **Historical review note:** This report describes the audited Git HEAD above. A later review of the attached working tree found and corrected a High-severity archived-share backup round-trip defect; see [Archived-page sharing backup round-trip integrity](archived-share-backup-roundtrip-integrity.md).

> **Latest attached-workspace note:** A subsequent review of Git HEAD `ecbc72365b769b3c8d021a9dba512992b95f9a1e` found no additional Critical or High normal-use data-loss path. It corrected a Medium false-success recovery risk caused by missing exact-length verification on streamed backup downloads. See [Backup stream and transport integrity](backup-stream-integrity.md).

## 1. Conclusion

No new **Critical** data-loss path—defined here as immediate permanent loss through remote or normal use—was reproduced. The current code already includes strong defenses such as serialized page/block writes, optimistic version checks, a durable Yjs log, server-authoritative materialization, restore journals and generation markers, and per-user attachment locks.

The review did reproduce one new integrity defect.

### BV-DI-2026-07-30-01 — false-success backup after same-size attachment mutation

- Impact: high
- Likelihood: low
- Overall severity: Medium
- Scope: backup export
- Immediate loss of source data: none
- Possible recovery failure: yes

If a staged attachment changed to different bytes of the same size after preflight validation but before ZIP streaming, the previous `ZipWriter.add()` checked only the byte count and wrote the earlier CRC32 into the header. The ZIP download could complete even though its actual payload no longer matched the CRC32 and SHA-256 recorded in the manifest, causing restore to reject it.

Normal BrainVault code does not rewrite the staged file, so this was not readily triggerable through remote user input alone. Local tampering, storage faults, interference by an operations script, or future code changes could nevertheless produce a false “backup succeeded” signal. Correcting it materially improves recovery reliability.

## 2. Correction

1. `src/lib/zip.ts`
   - Recalculates CRC32 over every chunk actually sent to the ZIP.
   - Optionally calculates SHA-256 during streaming and compares it with the preflight value.
   - Fails before writing the central directory when size, CRC32, or SHA-256 differs.
   - Does not blindly trust caller-provided CRC32 for buffer entries.
   - Replaced a TypeScript parameter property in the constructor with an equivalent explicit field so the module can be tested independently through Node's built-in type stripping.

2. `src/lib/data-transfer.ts`
   - Passes the attachment's preflight SHA-256 to `ZipWriter`, binding manifest values to emitted bytes.

3. Reproduction and verification
   - Added `scripts/reproduce-backup-stream-integrity-loss.mjs`.
   - Added `tests/backup-stream-integrity.node.test.mjs`.
   - Integrated source guards and vulnerable/corrected-state reproduction into `scripts/verify-data-loss-guards.mjs`.
   - Added `reproduce:backup-stream-integrity-loss` to `package.json`.

4. Existing reproducer correction
   - Fixed `scripts/reproduce-collaboration-bootstrap-loss.mjs`, which had incorrectly treated the current corrected `HEAD` as the vulnerable state.
   - It now locates historical vulnerable commit `243fba624c107dcf452fc9a7dcfcba86f9c9350b` in Git history and verifies the historical and current implementations separately.

## 3. Deep-review scope and results

### Database atomicity and concurrency

- MariaDB connections enforce strict transactional SQL mode.
- Major page and block mutations use transactions and `FOR UPDATE` locks.
- Edit/content-version CAS and mutation receipts prevent duplicate application during retry.
- Ambiguous commit outcomes are handled separately rather than assumed successful.
- Permanent deletion verifies an exact subtree snapshot and collaboration-materialization state.

No new permanent-loss path was reproduced.

### Yjs collaboration persistence and materialization

- Yjs updates enter the durable SQL log first.
- Initial document bootstrap must match existing SQL state semantically.
- Multi-instance paths compare the durable tip with the process-local room.
- Materialization reconstructs from the ordered durable Yjs log, not a client-submitted body.
- Snapshot insertion and deletion of old updates occur in one transaction.
- Browser recovery remains until acknowledgement, and a storage failure prevents live mutation exposure.

Existing regression reproducers demonstrated corrected behavior.

### Attachments

- Final publication uses a hard-link claim rather than overwrite-capable `rename()`.
- Files and directories are `fsync`ed, and files are preserved conservatively when database commit outcome is unclear.
- Backup, restore, and cleanup are serialized under per-user database locks.
- Restore verifies size, CRC32, SHA-256, and manifest relationships.

This audit found and corrected the missing revalidation during the export stream itself.

### Backup and restore

- Backup collects a consistent snapshot after locking the owned page set.
- Export is rejected when collaboration state is not fully materialized into SQL.
- Restore uses a temporary directory, journal, generation marker, atomic database replacement, and directory transition.
- The workspace fingerprint is rechecked before restore to block changes after preparation.
- ZIP paths, duplicates, sizes, CRC32, SHA-256, parents, and references are validated fail-closed.

After the correction, export completes only when the actual emitted bytes match the manifest.

### Migrations

- Migration 009's non-atomic DDL/backfill phases have dedicated durable-marker recovery.
- No new reproducible deletion defect was found in other current migrations within the audit scope.
- MariaDB DDL can implicitly commit, so future data-transform migrations should continue using step markers and restartable design.

### Browser local recovery

- Malformed or empty direct-draft, collaboration-recovery, and transition-lock records are not mistaken for a safe absent state.
- Cross-tab ownership, expiry, and transition fences are checked.
- Durable-before-visible ordering is preserved after storage failure.

No new permanent-loss path was reproduced.

## 4. Reproduction results

### New defect

```bash
npm run reproduce:backup-stream-integrity-loss
```

Verified vulnerable state:

- Source changed after preflight: true
- File size unchanged: true
- Previous export could complete: true
- Generated backup passes restore-integrity validation: false
- False-success unrestorable backup reproduced: true

Verified corrected state:

- Streaming CRC32 mismatch rejected: true
- SHA-256 mismatch rejected even when CRC32 matches actual bytes: true
- Export stops before central-directory completion: true

### Existing bootstrap-loss reproduction

```bash
npm run reproduce:bootstrap-loss
```

- Historical vulnerable commit located automatically: `243fba624c107dcf452fc9a7dcfcba86f9c9350b`
- Historical state in which an incomplete first Yjs document could reduce two SQL blocks to zero: reproduced
- Current implementation rejects the bootstrap and preserves both SQL blocks: verified

## 5. Verification results

- `node --experimental-strip-types --test tests/*.node.test.mjs`: all passed
- `node scripts/verify-data-loss-guards.mjs`: passed
- `node --experimental-strip-types scripts/verify-collaboration.mjs`: passed, including source wiring, protocol, and syntax checks for 152 files
- New ZIP regression tests:
  - Reject same-size file mutation
  - Complete a valid CRC32/SHA-256 ZIP
  - Reject SHA-256 mismatch even when CRC32 matches
  - Reject an invalid caller-provided buffer CRC32
- Modified script syntax checks: passed

## 6. Verification limitations

`npm ci --ignore-scripts` failed because the environment's internal npm proxy returned `404` for `zod-3.25.76.tgz`. The full Vitest suite, formal `tsc` build, and live MariaDB integration tests were therefore not run. A global `tsc` could not begin a full project check because project dependencies such as `@types/node` and `vitest/globals` were absent.

Dependency-free Node regression tests, every built-in data-loss reproducer, the collaboration verifier, syntax checks for changed files, and static tracing of write/delete paths were run instead. Before deployment, run:

```bash
npm ci
npm run check
```

## 7. `.git` preservation

- `.git` was not deleted, initialized, committed, or garbage-collected.
- A SHA-256 manifest for 28 `.git` files was created at audit start.
- All 28 entries matched after the correction.
- The packaging procedure includes the same verification against the final ZIP.

## 8. Changed files

Tracked files:

- `src/lib/zip.ts`
- `src/lib/data-transfer.ts`
- `scripts/reproduce-collaboration-bootstrap-loss.mjs`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- Documentation index

New files:

- `scripts/reproduce-backup-stream-integrity-loss.mjs`
- `tests/backup-stream-integrity.node.test.mjs`
- Backup-stream integrity report
- This independent review

## 9. Official references

- PKWARE APPNOTE ZIP File Format Specification: per-file CRC32 and local/central-header requirements
- Node.js Crypto API: `crypto.createHash()` and SHA-256 digest calculation
- Node.js File System API: storage-flush meaning of `FileHandle.sync()`
- MariaDB Server documentation: transactions, commit/rollback, and `SELECT ... FOR UPDATE`
- Yjs documentation: document updates, ordered application, and state-update model
