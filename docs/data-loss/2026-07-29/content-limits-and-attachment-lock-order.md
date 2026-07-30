# BrainVault data-preservation follow-up audit and correction report

Audit date: 2026-07-29 (Asia/Seoul)  
Scope: the complete uploaded `BrainVault.zip` source and preserved `.git` history  
Focus: editor input, browser recovery copies, Yjs persistence, database materialization, attachments, and backup/restore

## 1. Conclusion

The audit identified and corrected one new **High-severity data-loss defect**.

On a shared page, when a title exceeded 160 characters or a normal block body exceeded 20,000 characters, the previous implementation left the excess text visible in the UI while silently writing only the truncated value to the Yjs document and browser recovery copy. The user could reasonably believe the full value had been saved, but the excess text could disappear after a refresh.

The correction establishes the following invariant:

```text
A collaborative edit shown as saved in the UI
    ⇒ the identical complete value is present in browser recovery and the Yjs persistence candidate
```

Values beyond the allowed length are no longer truncated and stored. Normal UI input cannot exceed the server limit, and attempts that bypass the UI through scripts, browser extensions, or future regressions are explicitly rejected before a collaboration mutation is created.

The review also rechecked browser drafts, save queues, deletion/restore transition locks, server-authoritative Yjs materialization, attachment claiming and `fsync`, and backup/restore journal paths. No additional Critical or High permanent-loss path remained reproducible in the reviewed scope after the correction.

## 2. Confirmed permanent-loss sequence

The vulnerable implementation allowed the following sequence:

1. A user pastes a 161-character shared-page title or a 20,001-character block body.
2. The DOM retains the complete string.
3. The title path applies `slice(0, 160)`, and block normalization applies `slice(0, 20_000)`.
4. Only the truncated value enters the Yjs staging document and browser recovery.
5. The edit row is shown as saved.
6. After refresh, the trailing text that never reached the server or Yjs history cannot be recovered.

Non-collaborative editing did not have the same silent-loss behavior because server length validation rejected the request while the full input remained in the browser's direct draft. The defect was specific to the collaboration path treating the UI value and the durable candidate as different data.

## 3. Implemented correction

### 3.1 Fail closed before mutation instead of truncating

`public/editor-content-limits.js` now defines the title and body limits and provides common validators.

- Title: 160 characters
- Block body: 20,000 characters
- Exact boundary values are returned unchanged.
- Over-limit values are rejected with `EDITOR_CONTENT_LIMIT_EXCEEDED` before any mutation occurs.

The following paths in `public/collaboration.js` use the common validator:

- `setTitle`
- `normalizeBlock`, `upsertBlock`, and `upsertBlocks`
- Reading a Yjs document snapshot
- Bootstrapping a collaboration document from a relational page
- Receiving a collaboration-session document

Inbound and bootstrap state therefore cannot be silently shortened either.

### 3.2 UI and server limits aligned

- Added `maxlength="160"` to the page-title input.
- Applied `maxLength = 20_000` to normal text-block text areas.
- Removed the title truncation previously performed by `schedulePageTitleSave()` before the Yjs call.
- Applied the common validator when collaboration snapshots are copied into application state.
- Added the 20,000-character block-body limit to backup-manifest validation so a restored backup cannot first become lossy when collaboration is enabled later.

The UI limits guide normal input, while storage-layer validation blocks UI bypasses and future regressions.

### 3.3 Attachment-upload deadlock prevention

Attachment upload previously locked the page row before the owner row. Export, restore, and attachment cleanup used the opposite order: owner row first, then page row. Concurrent operations could therefore deadlock through a `page → user` versus `user → page` lock inversion and fail a save.

Upload now follows this order:

```text
preflight access check
→ owner user row FOR UPDATE
→ page row FOR UPDATE and access recheck
→ owner invariant check
→ parent revalidation
→ durable file move
→ block INSERT and content_version increment
```

An abnormal ownership-generation change between preflight and locking fails closed with `409`. The file is moved only after both locks and all revalidation steps succeed.

### 3.4 Partial output from failed builds blocked

The previous `npm run build` could update some files under `dist` even when TypeScript reported errors. To prevent a deployment from mixing corrected and stale build output:

- The build removes only the validated `dist` path before compilation.
- `noEmitOnError: true` is enabled.
- Existing TypeScript errors were corrected.
- Vitest-only and `node:test`-only files were separated.
- The default `npm test` runs both the regular suite and durability tests.
- `npm run check` combines the build, full tests, and both data-loss verifiers.

## 4. Verification results

Final command:

```bash
npm run check
```

Result:

```text
TypeScript build:      PASS
Vitest:                 58 files, 316 tests, 316 pass
Durability tests:       13 tests, 13 pass
verify:data-loss:       PASS
verify:collaboration:   PASS
```

New regression coverage verifies:

- Preservation at the exact title and body limits
- Rejection, rather than truncation, above the limits
- No reintroduction of `.slice()` before title save
- Title/block validation before collaboration mutation
- The same strict validation for snapshot and bootstrap paths
- UI `maxlength` values matching server limits
- Attachment-upload lock order: `user → page → file move → INSERT`
- Restored route and UI mocks/assertions aligned with the latest conflict, reorder, and page-list defenses

## 5. Audit scope

The following paths were re-reviewed through source inspection and tests:

- Pre-network `localStorage` persistence and rollback for direct title/block drafts
- Revision and mutation IDs, response-loss retries, and latest-edit rebasing
- Browser recovery fences before page/block deletion, archive, sharing transitions, and full restore
- Durable-before-visible Yjs recovery and cleanup after acknowledgement
- Multi-process stale-room durable-tip fence
- Server-authoritative Yjs materialization and destructive checkpoints
- Attachment exclusive claim, `fsync`, file preservation when commit outcome is ambiguous, and post-delete rechecks
- ZIP export/restore fingerprints, SHA-256/CRC, staging, and generation journals
- Rerunnable migration defenses and baseline operational documentation

## 6. Remaining operational assumptions and limitations

The conclusion is based on source review and automated tests. The audit environment did not support live MariaDB forced-stop/restart tests or real multi-tab browser end-to-end testing. Before production deployment, run tests covering concurrent upload and export/restore, termination immediately before and after database commit, disk exhaustion, and forced browser termination.

The following assumptions also remain mandatory:

1. Built-in collaboration room fan-out is process-local. Use one active application process until shared pub/sub and a distributed room coordinator are implemented.
2. `ATTACHMENT_UPLOAD_DIR` must be a persistent volume backed up together with the database. On multiple hosts, all writers must see the same file store and recovery journal.
3. Back up MariaDB and the attachment volume at the same logical point in time and practice real restores regularly.
4. At the time of this audit, a user ZIP preserved materialized owned-page content and attachments but did not preserve the sharing grant list or Yjs update history. Restored owned pages therefore became unshared. A later dedicated share-integrity correction supersedes this limitation for current backups.
5. Run schema changes through a single migration job. For production, add pre-migration backups and an advisory-lock/checksum-based deployment procedure.

## 7. Changed-file summary

Core product code:

- `public/editor-content-limits.js`
- `public/app.js`
- `public/collaboration.js`
- `public/index.html`
- `src/routes/block.routes.ts`
- `src/lib/data-transfer.ts`

Build and verification:

- `scripts/clean-dist.mjs`
- `package.json`
- `tsconfig.json`
- `public/i18n.d.ts`
- `tests/editor-content-limits.node.test.mjs`
- `tests/editor-content-limits-ui.test.ts`
- Route/UI test mocks and assertions that had drifted from the current implementation

Git history was not rewritten, and the delivered archive includes the uploaded `.git` directory.
