# Data-loss audit: collaboration document lineage

Audit date: 2026-07-28 (Asia/Seoul)

## Executive finding

A critical cross-generation recovery bug could merge an obsolete offline Yjs document into a deliberately replaced page that reused the same page ID. The affected replacement paths included full workspace restore and disabling then re-enabling collaboration. Depending on the stale document state, this could resurrect old blocks, reapply old deletions, replace a restored title, or materialize an obsolete document over the restored relational page.

The fix introduces a server-issued `documentEpoch` as a generation fence and applies it consistently to session issuance, signed WebSocket tickets, in-memory rooms, every durable Yjs write, relational materialization, browser recovery keys, and manual recovery grouping. It also requires a generation-aware client capability marker before issuing a new session, so a browser tab running the pre-fix JavaScript cannot reconnect and replay a legacy recovery record after deployment.

Severity: **Critical**

## Reproduction before the fix

1. Page `P` is collaborative. Browser/device B edits while disconnected and retains a local full-document recovery update.
2. Browser/device A completes a full workspace restore that replaces page `P`, or removes the final collaborator and later enables sharing again. The server intentionally deletes the old Yjs update history and collaboration state while the page ID can remain `P`.
3. Device B reconnects. The old client loaded every local recovery record for page ID `P` before it requested the current server session.
4. The recovered Yjs state was merged into the client document without any identifier proving that it belonged to the current server document generation.
5. The client sent a full state update. If the new room was empty, stale recovery also prevented canonical bootstrap because the local document was already populated. The server accepted the update as a valid edit to page `P`.
6. Periodic materialization could then write the obsolete title, blocks, ordering, and attachment tombstones over the restored page.

A second deployment-specific path existed: an already-open tab running pre-fix JavaScript could request a new session from the upgraded server. Without explicit capability negotiation, the new server could issue a current-generation ticket after the old client had already applied an unversioned recovery record.

## Root cause

The system treated `pageId` as both the stable relational identity and the identity of a particular Yjs history. Those identities diverge whenever collaboration history is intentionally reset while the page ID is retained. Browser recovery records likewise used only account, page, and source-tab identity, so the same tab could overwrite an older generation's last recovery copy with a newer one.

The previous safety controls correctly handled update acknowledgements, commit ambiguity, multi-tab exit coordination, stale materialization IDs, and transactional restore. None of them established a lineage boundary between two different Yjs documents sharing the same page ID.

## Implemented correction

### Database and migration

- Added migration `021_collaboration_document_epoch.sql`.
- Added non-null `page_collaboration_state.document_epoch`.
- Existing state rows receive an epoch without deleting collaboration history.
- New epochs are created atomically whenever a collaboration generation is initialized.

### HTTP session and ticket boundary

- Session creation locks the page, ensures the collaboration state row, and returns `documentEpoch`.
- The signed collaboration JWT contains the same epoch.
- Session creation requires `{ "documentEpochProtocol": 1 }`. Pre-fix tabs cannot obtain a replacement ticket and must refresh, while their legacy local record remains preserved.

### WebSocket and durable write boundary

- The upgrade handler compares the ticket epoch with current database state before accepting the room.
- Rooms are keyed by page and carry a single epoch. A different epoch invalidates the stale room.
- State is rechecked after history loading to close the upgrade/load race.
- Every Yjs insert or compaction transaction locks the page and state row and rechecks the client epoch before writing.
- Periodic access checks also detect epoch replacement.
- Stale clients receive close code `4011`; queued stale writes are discarded before the in-memory document is swapped.

### Relational materialization boundary

- Snapshot requests require `documentEpoch`.
- Materialization locks and verifies the epoch before changing page or block rows.
- The materialization marker update includes the epoch in its `WHERE` clause.

### Browser recovery boundary

- Recovery schema version 2 keys each copy by account, page, document epoch, and source tab.
- The client requests the server session before loading recovery and applies only exact-epoch records.
- Legacy and mismatched records are preserved, never auto-merged, and never overwritten by a new generation from the same tab.
- A valid same-epoch recovery record suppresses canonical bootstrap even when the recovered Yjs document is intentionally empty.
- Manual recovery output groups records by page and epoch and refuses to merge mixed generations.
- Records that cannot currently be parsed or applied are skipped but not automatically deleted, preserving their raw bytes for manual or future-version recovery.

## Other audited data-loss surfaces

No additional critical defect was identified in the following paths during this review:

- Direct title/block saves: durable per-tab drafts are written before network submission; optimistic versions and mutation request hashes prevent stale or ambiguous retries from silently overwriting newer content.
- Save coalescing: a failed/ambiguous write remains ahead of newer queued edits, so a newer edit is not sent against an unknown server version.
- Destructive transitions: archive, permanent delete, final-share removal, and workspace replacement check pending local/collaboration state and use page/workspace transition locks.
- Workspace restore and attachments: database replacement is transactionally fingerprinted; live collaboration rooms are invalidated before replacement; attachment generations use journals, checksums, fsync, and commit-outcome recovery.
- Block deletion/reordering: version snapshots, hierarchy locks, cycle validation, and idempotent mutation receipts prevent stale structure changes from being silently applied.

These findings are code-audit conclusions rather than a substitute for the unavailable full database/browser integration suite described below.

## Validation performed

Successful checks in the audit environment:

```text
npm run lockfile:check
[lockfile-registry] OK: 347 resolved URL(s) use approved portable registry hosts.

npm run verify:collaboration
[verify-collaboration] OK: source wiring, exact Yjs dependency pins, recovery acknowledgement safety, document-lineage isolation, hierarchy invariants, RFC 6455 protocol behavior, and syntax for 121 file(s).

[recovery-lineage-smoke] OK
[openapi-yaml] OK
[migration-021-safety] OK
```

The verifier now asserts:

- migration and lineage-helper wiring;
- epoch-bound token, WebSocket, persistence, and snapshot paths;
- client capability negotiation;
- server-session-before-recovery ordering;
- same-tab recovery coexistence across two epochs;
- legacy schema-v1 preservation;
- undecodable recovery-record preservation;
- generation-safe deletion;
- close code `4011` handling; and
- JavaScript/TypeScript syntax for all scanned sources.

## Environment limitation

A clean dependency installation was attempted repeatedly, including offline mode. The configured package gateway returned HTTP 503 for the existing locked dependency `zod-3.25.76.tgz`, and the local npm cache did not contain it. Consequently the audit environment could not run the full TypeScript build, Vitest suite, or MariaDB integration suite after a clean install. No lockfile or dependency version was changed. Run the following in an environment with registry and MariaDB access before production deployment:

```bash
npm ci
npm run build
npm test
npm run db:migrate
```

## Deployment note

Apply migration 021 before serving the updated application. A pre-fix browser tab will be denied a new collaboration session until refreshed. Do not delete browser recovery storage during rollout; legacy and undecodable records are intentionally retained for manual recovery.
