# BrainVault backup sharing-permission integrity deep audit

- Audit date: 2026-07-30
- Baseline Git commit: `69610238d9e0686b2546619edcfa4ffe194c48f9`
- Scope: complete attached BrainVault source and `.git` history
- Focus: MariaDB transactions and foreign keys, full backup/restore, attachment generation transitions, Yjs collaboration state, browser recovery, and migration rerun safety

## Conclusion

The previous implementation contained a **High-severity data-integrity defect that could permanently remove every page-sharing permission even when a full workspace restore completed successfully**.

The defect did not delete note text or attachment bytes directly, but `page_shares` is user-configured workspace state and access-relationship data. The UI and documentation described the feature as complete backup/restore, while the backup manifest omitted those relationships. Restore deleted the user's pages first; `ON DELETE CASCADE` removed all existing share rows, and the restore never recreated them.

The corrected implementation guarantees:

1. New backups store page-sharing relationships using the collaborator's stable account ID and username.
2. Restore resolves every collaborator by account ID, verifies the exact ID-and-username pair, and acquires row locks before destructive deletion.
3. A missing or mismatched account, self-share, duplicate share, nonexistent page, mixed identity generation, or share on a collection causes failure **before any data is replaced**.
4. A valid current-format backup reinserts `page_shares` inside the restore transaction.
5. For legacy backups without `pageShares`, existing grants for the same restorable page IDs are preserved.
6. The API and all seven UI languages report the number of restored sharing grants.

## 2026-07-30 identity-binding addendum

A subsequent review found a separate High-severity flaw in the first sharing-backup correction: `shared_username` alone could bind an exported editor grant to an unrelated same-named account on another server. New exports now include `shared_user_id` and `shared_username`; restore requires the exact pair under row locks before destructive replacement. Username-only `pageShares` records are accepted only when they match currently locked page-to-account grants, and mixed identity generations are rejected. See [Backup collaborator identity integrity](backup-share-identity-integrity.md).

## New defect: permanent sharing-permission loss after full restore

### Severity

**High — data/configuration integrity loss**

Impact:

- Every invited editor can be removed despite a successful restore.
- The backup contains no way to reconstruct the share targets or permissions.
- Manual recovery can be incomplete when the user did not separately record who had access to each page.
- The successful restore response does not make the loss obvious.

### Root cause

Migration `020_page_sharing_yjs_collaboration.sql` defines:

```sql
CONSTRAINT fk_page_shares_page
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
```

The old restore path executed:

```sql
DELETE FROM pages WHERE owner_id = ?
```

The previous backup manifest stored `pages`, `blocks`, `tags`, `pageTags`, and attachments, but did not export or reinsert `page_shares`. As soon as page deletion succeeded, the share rows were removed by the foreign-key cascade. The restore transaction then committed without recreating them.

### Reproduction

The project adds:

```bash
npm run reproduce:backup-share-loss
```

The reproducer compares the vulnerable source at Git `HEAD` with the corrected working tree and verifies:

- The vulnerable manifest omits `pageShares`.
- The vulnerable restore deletes all owned pages.
- The vulnerable restore does not reinsert `page_shares`.
- A successful restore reduces the grant count from 1 to 0.
- The corrected current and legacy paths both preserve sharing relationships.

An independent SQL foreign-key reproduction also confirmed that deleting the parent page under `ON DELETE CASCADE` reduced the share-row count from `1 → 0`. The temporary verification output was intentionally excluded from this reorganized project.

## Correction

### 1. Backup manifest extended

`src/lib/data-transfer.ts` now defines `pageShareSchema` and optional `data.pageShares`.

Stored fields:

- `page_id`
- `shared_user_id` (present in all new exports)
- `shared_username`
- `permission` (only `EDIT` is accepted)
- `created_at`

`pageShares` remains optional for backward compatibility with existing version-1 backups. Every newly generated backup includes the array.

### 2. Relationship validation before restore

Manifest relationship validation now enforces:

- No duplicate `(page_id, lower(shared_username))` pairs
- The shared page must exist in the manifest
- Collections cannot receive sharing relationships
- Archived ordinary pages may retain sharing relationships while live collaboration is suspended so an export can be restored losslessly
- Permission must be `EDIT`

### 3. Collaborator resolution and locking before destructive deletion

For a current-format backup, collaborator account IDs are resolved to `users` rows and locked with `FOR UPDATE`; the stored username must also match the locked account.

The restore fails with `INVALID_DATA_BACKUP` before `DELETE FROM pages` when:

- A collaborator account does not exist on the destination server
- The owner is listed as their own collaborator
- A manifest relationship is otherwise invalid

The row locks also close races with concurrent user deletion or account changes during restore.

### 4. Sharing preservation for legacy backups

A backup without `pageShares` cannot reveal the sharing state that existed when it was created. Instead of deleting all grants, the corrected restore snapshots and reinserts currently locked share rows that meet all of these conditions:

- The backup contains the same page ID
- The page is not a collection
- The collaborator account still exists
- Archived ordinary pages remain eligible because their grants are retained rather than deleted

The restore response reports `sharing.mode` as `legacy-preserved` for this path.

### 5. Reinsertion within the transaction

After pages, blocks, tags, and tag relationships are restored, `page_shares` is reinserted in the same database transaction. Any insertion failure rolls back the complete database replacement. Existing restore-journal and attachment-generation transition logic remains unchanged.

### 6. API, UI, and documentation synchronized

- `/api/data/import` returns `counts.shares` and a `sharing` result.
- The OpenAPI response schema was updated.
- Restore completion messages display the number of sharing grants.
- English, Japanese, Korean, French, German, Spanish, and Portuguese UI messages were updated.
- Features, Security, API, and documentation-index content was updated.

## Regression and reproduction verification

Dependency-independent verification completed after the correction:

```text
node --experimental-strip-types --test tests/*.node.test.mjs
50 tests passed, 0 failed
```

```text
node scripts/verify-data-loss-guards.mjs
OK
```

```text
node --experimental-strip-types scripts/verify-collaboration.mjs
OK — source/protocol checks and syntax for 166 files
```

```text
node scripts/reproduce-backup-share-loss.mjs
vulnerable state reproduced; fixed new/legacy paths preserved shares
```

Added tests:

- `tests/backup-share-integrity.node.test.mjs`
- `tests/archived-share-backup-integrity.node.test.mjs`
- Sharing-relationship ZIP round-trip coverage in `tests/data-transfer.routes.test.ts`, including archived ordinary pages

## Archived-page round-trip addendum

A later review found that the exporter could include a retained grant for an archived ordinary page while the importer rejected the same relationship. This made an application-generated ZIP self-unrestorable and caused legacy restore to drop the retained grant through the page foreign-key cascade.

The corrected policy treats archive as a collaboration suspension rather than grant deletion. Both current-format validation and legacy-grant preservation now accept ordinary archived pages while continuing to reject collections. The dedicated report and reproducer are:

- [Archived-page sharing backup round-trip integrity](archived-share-backup-roundtrip-integrity.md)
- `npm run reproduce:archived-share-backup-loss`

## Existing major defenses rechecked during the audit

The review also statically traced and reran existing reproduction tests for:

- Transactional database writes and strict transactional SQL mode
- Page/block edit-version CAS and ambiguous commit handling
- Attachment hard-link claim, `fsync`, restore journal, and generation markers
- CRC32 and SHA-256 revalidation during ZIP streaming
- Durable Yjs update log, document epoch, and server-authoritative materialization
- Live collaboration-room invalidation before restore
- Fail-closed browser direct-draft and Yjs-recovery inspection
- Page-scoped composite foreign key for block parents
- Lossless boundaries for structured metadata and block sort order
- Migration rerun safety and DDL boundaries

No separate new path was reproduced that bypassed those defenses to delete note text or attachment bytes. This is not a mathematical proof of absence; continued validation in live MariaDB, multi-server, and fault-injection environments remains necessary.

## Verification-environment limitations

`npm ci --ignore-scripts` could not complete because the environment's internal npm mirror returned `404` for the `zod@3.25.76` tarball, not because of a project-source error. The following were therefore not run in that environment:

- Full Vitest suite
- Full project type check/build through `tsc`
- Live MariaDB integration round-trip
- Real browser end-to-end tests

The audit instead ran the Node built-in test runner, TypeScript syntax stripping/checking, project data-loss and collaboration verifiers, and deterministic reproducers. Before deployment, run:

```bash
npm ci
npm test
npm run build
npm run verify:data-loss
npm run verify:collaboration
```

At minimum, verify these scenarios against a MariaDB test account:

1. Export/import round-trip for a current backup containing one shared page
2. Failure before deletion when the destination lacks a collaborator account
3. Preservation of the current grant when restoring a legacy manifest with `pageShares` removed
4. Journal recovery after server termination during restore, with database, attachment, and share state remaining consistent
5. Export/import round-trip for an archived ordinary page with a retained editor grant
6. Restore-generation fencing of stale Yjs documents with two server instances and open collaboration tabs

## Changed files

Core code:

- `src/lib/data-transfer.ts`
- `src/lib/page-share-integrity.ts`
- `src/routes/data.routes.ts`
- `public/app.js`
- `public/i18n.js`

Tests and reproduction:

- `scripts/reproduce-backup-share-loss.mjs`
- `scripts/reproduce-archived-share-backup-loss.mjs`
- `scripts/verify-data-loss-guards.mjs`
- `scripts/verify-collaboration.mjs`
- `tests/backup-share-integrity.node.test.mjs`
- `tests/archived-share-backup-integrity.node.test.mjs`
- `tests/data-transfer.routes.test.ts`
- `package.json`

Contracts and documentation:

- `docs/api/2026-07-30/openapi.yaml`
- `docs/api/2026-07-30/api.md`
- `docs/features/2026-07-30/features.md`
- `docs/security/2026-07-30/security.md`
- `docs/README.md`
- `README.md`

## `.git` preservation

The correction did not delete or recreate `.git`. The original ZIP and modified working directory contained the same 43 `.git` entries, including 28 regular files, and every regular file was byte-identical. An index stat-cache update caused by status inspection was reversed by restoring the original `.git/index`; its final SHA-256 was `e82113c1c9ee6271f38474fb7f2a9d2178c21e1408dc614d04736bc33c73620d`. The delivered ZIP was also extracted into a separate directory to recheck the project file inventory, `.git` bytes, durability tests, and both verification scripts.
