# BrainVault data-loss integrity follow-up deep audit and correction report

Audit date: 2026-07-29 (Asia/Seoul)  
Scope: complete uploaded `BrainVault.zip` source, preserved Git metadata, and collaboration/restore/attachment durability paths  
Review type: independent follow-up after the 2026-07-29 browser recovery-write audit

## 1. Final conclusion

The uploaded project already contained defenses for the ten critical data-loss findings identified in earlier audits, and their reproducers and static guards passed again. The follow-up review nevertheless found an independent **11th Critical integrity vulnerability** in the path that reconciled collaborative attachment-block positions after reconnect.

In the vulnerable version, a user could move an attachment block to a new parent or order and receive a Yjs acknowledgement from the server. If the client reconnected before relational materialization, the following sequence was possible:

1. The durable Yjs log contained the new position.
2. The `blocks` SQL row still contained the old position.
3. The reconnect HTTP response returned the old SQL position.
4. WebSocket history replay restored the new durable Yjs position.
5. Client attachment reconciliation overwrote that new position with the stale SQL `parentBlockId` and `sortOrder`.
6. The overwrite was persisted and acknowledged as a new local Yjs update.
7. The next materialization wrote the stale position back to SQL.

A reconnect could therefore permanently remove an attachment move, hierarchy change, or ordering change that the server had already accepted and acknowledged. The attachment bytes remained intact, but the user's committed document-structure data was lost.

The correction enforces this authority rule:

> Server SQL is authoritative for immutable attachment content and file metadata. For an attachment that already exists in the Yjs document, durable Yjs state is authoritative for its mutable position.

Severity: **Critical**

## 2. Vulnerable code path

The central issue was `reconcileServerAttachments()` in `public/collaboration.js`.

During reconnect, the server delivered state from two paths representing different points in time:

- HTTP collaboration session: current relational `blocks` snapshot
- WebSocket history: durable `page_yjs_updates` log

The relational snapshot can legitimately lag behind Yjs because materialization is asynchronous. The vulnerable implementation nevertheless applied every field from the server attachment candidate to the existing Yjs map.

```text
canonical SQL attachment
  ├─ immutable content/metadata   ← safe for the server to overwrite
  └─ parentBlockId/sortOrder      ← may be stale before materialization
```

During `sync-complete`, durable Yjs history was applied first and `mergeCanonicalAttachments()` ran afterward. The stale SQL position was therefore recorded as a fresh local change over the current Yjs position. The same defect could occur when a delayed `canonical-attachment` message reached an attachment that had already been moved.

## 3. Reproducible permanent-loss sequence

The deterministic reproducer uses this state:

```text
Acknowledged durable Yjs position
parentBlockId = section_after
sortOrder     = 1

SQL position not yet materialized
parentBlockId = section_before
sortOrder     = 7
```

Vulnerable merge result:

```json
{
  "reconnectPublishedLocation": {
    "parentBlockId": "section_before",
    "sortOrder": 7
  },
  "staleSqlLocationRepublishedAsNewYjsUpdate": true,
  "acknowledgedMoveSurvived": false,
  "permanentLossWindowReproduced": true
}
```

Corrected merge result:

```json
{
  "reconnectPublishedLocation": {
    "parentBlockId": "section_after",
    "sortOrder": 1
  },
  "acknowledgedMoveSurvived": true,
  "canonicalImmutableContentPreserved": true,
  "missingAttachmentUsesSqlLocation": true,
  "permanentLossWindowClosed": true
}
```

Run:

```bash
npm run reproduce:attachment-position-loss
```

The reproducer executes the vulnerable and corrected merge logic against the same input without requiring external packages, a browser, or MariaDB.

## 4. Root cause

The root cause was treating an **eventually materialized view as the newest collaboration-authoritative state**.

A Yjs update is durable in `page_yjs_updates` when the server acknowledges it. The `pages` and `blocks` tables used by normal REST reads, search, and backup can lag until the next materialization. While the two stores differ, authority must be assigned per field:

| Data | Authoritative store | Reason |
| --- | --- | --- |
| Attachment ID/type | SQL plus validated Yjs identity | File-row linkage and type invariants |
| Filename, MIME type, size metadata | SQL | Server-generated upload values |
| Attachment deletion | Yjs tombstone | Collaborative deletion intent and materialization input |
| Parent/order of an attachment already in Yjs | Durable Yjs | Latest acknowledged collaborative edit |
| Parent/order of a new attachment not yet in Yjs | SQL | Canonical adoption immediately after upload |

The old implementation did not distinguish the last two cases and always applied the SQL position.

## 5. Implemented correction

### 5.1 Field-authority reconciliation module

A new pure function, `reconcileCanonicalAttachment()`, was added in `public/collaboration-attachment-reconcile.js`.

- When the attachment already exists in Yjs, preserve its `parentBlockId` and `sortOrder`.
- Adopt the SQL position only when the attachment is genuinely absent from Yjs.
- Keep canonical SQL values for type, markdown, checked state, and attachment metadata.
- If the current Yjs parent has been deleted or does not exist, fail closed to root (`null`) instead of reverting to the stale SQL parent.
- Normalize self-parent relationships and invalid sort values.

### 5.2 Tombstone-aware active-ID calculation

`reconcileServerAttachments()` excludes attachment tombstone IDs from the set of candidate active parents. This prevents a deleted block from being treated as a valid parent and resurrecting structure.

### 5.3 Same rule for reconnect and canonical broadcasts

`adoptAttachment()` now uses the same reconciliation rule for:

- `mergeCanonicalAttachments()` during reconnect
- `canonical-attachment` WebSocket notifications after upload
- Adoption of an HTTP upload response during a screen transition

### 5.4 Old-writer compatibility fence

A cached vulnerable browser could republish stale SQL positions when mixed with the corrected server. A bidirectional compatibility fence prevents that mixed deployment:

- Collaboration-session body: `documentEpochProtocol: 2`
- WebSocket subprotocol: `brainvault-yjs-v2`

The new server rejects protocol-1 session requests with `COLLABORATION_CLIENT_REFRESH_REQUIRED`. A protocol-1 ticket issued before deployment is also rejected after a rolling restart because the WebSocket subprotocol no longer matches. The new client likewise does not connect to an old server.

## 6. Regression tests

Four Node built-in tests were added:

1. An existing attachment preserves its Yjs position while adopting canonical content and metadata.
2. A new attachment absent from Yjs adopts its SQL position.
3. A missing current Yjs parent does not fall back to the stale SQL parent.
4. Self-parent and invalid sort values are normalized fail-closed.

They run together with the existing five browser-recovery durability tests.

```text
npm run test:durability
tests: 9
pass: 9
fail: 0
```

## 7. Static and state-machine verification integration

### `npm run verify:collaboration`

Added checks verify that:

- The collaboration client imports the pure reconciliation helper.
- The existing Yjs map is read before reconciliation.
- Tombstones are excluded from the active-parent set.
- `brainvault-yjs-v2` is the server upgrade protocol.
- Both vulnerable and corrected reproduction outputs match expectations.
- All executable JavaScript and TypeScript files pass syntax checks.

Final result:

```text
[verify-collaboration] OK ... stale-SQL attachment-position fencing ... syntax for 137 file(s).
```

### `npm run verify:data-loss`

Added checks verify that:

- The obsolete path that unconditionally reapplied SQL attachment positions is gone.
- Per-field authority preserves Yjs position and canonical SQL content.
- The attachment-position reproducer demonstrates both the vulnerable and corrected states.

Final result:

```text
[verify-data-loss-guards] OK ... stale-SQL attachment-position fencing ...
```

## 8. Existing loss defenses revalidated

The following reproducers were rerun after the correction:

```text
npm run reproduce:materialization-loss
vulnerable.permanentLossWindowReproduced=true
fixed.legacyCheckpointRequiresRematerialization=true
fixed.permanentLossWindowClosed=true

npm run reproduce:cross-instance-loss
vulnerable.permanentLossWindowReproduced=true
fixed.staleNormalWriteRejected=true
fixed.staleRoomInvalidated=true
fixed.permanentLossWindowClosed=true

npm run reproduce:recovery-write-loss
vulnerable.permanentLossWindowReproduced=true
fixed.storageFailure.rejectedWithDurabilityError=true
fixed.storageFailure.unprotectedEditBecameVisible=false
fixed.permanentLossWindowClosed=true
```

The following paths were also manually retraced:

- Yjs update persistence, acknowledgement, broadcast, reconnect recovery, and compaction
- Server-authoritative materialization and destructive checkpoints
- Page/block deletion and exact version snapshots
- Sharing enable/disable and document-epoch replacement
- Attachment claiming, `fsync`, database-commit ambiguity, and post-delete file cleanup
- Full ZIP export/restore fingerprints, journals, generation markers, and crash recovery
- Multi-tab Web Locks, durable leases, and storage-enumeration failure
- Inclusion of page, tag, and sharing changes in restore fingerprints

No additional uncorrected Critical data-loss path was identified in this follow-up review beyond the 11th issue. This conclusion is limited to the source and state-machine audit and the execution constraints below.

## 9. Dependency-installation and integration-test limitations

The registry forced by the execution environment did not provide the `zod-3.25.76.tgz` referenced by the existing lockfile, and overriding it with the public registry also did not complete. The following clean-install-dependent checks were not run in that environment:

- `npm run build`
- Full Vitest suite
- Live MariaDB integration/end-to-end testing
- Real browser multi-tab and WebSocket reconnect testing

`package-lock.json` and dependency versions were not changed. Run the following in a deployment environment with a working registry and MariaDB:

```bash
npm ci
npm run build
npm test
npm run db:migrate
```

The core correction was isolated in a dependency-free pure module and directly verified with Node built-in tests, deterministic reproduction, source wiring, and syntax checks.

## 10. Safe deployment conditions

1. Drain and stop all old BrainVault application writers.
2. Deploy the corrected build and restart server processes to close existing WebSockets.
3. Require users to refresh every open BrainVault tab.
4. Do not delete BrainVault browser recovery or `localStorage` data.
5. Treat protocol-1 session errors as intentional fail-closed behavior and refresh to load the protocol-2 client.
6. For multi-instance operation, use shared pub/sub and distributed room coordination as described in the collaboration documentation.
7. Complete the full build, Vitest, and MariaDB checks in a normal environment before production rollout.

## 11. Changed files

New:

- `public/collaboration-attachment-reconcile.js`
- `scripts/reproduce-attachment-position-loss.mjs`
- `tests/collaboration-attachment-reconcile.node.test.mjs`
- This audit report

Major modifications:

- `public/collaboration.js`
- `src/routes/collaboration.routes.ts`
- `src/lib/collaboration-server.ts`
- `scripts/verify-collaboration.mjs`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- Related collaboration, API, OpenAPI, verification documentation, and tests

No project file was deleted as part of the original correction, and `package-lock.json` was unchanged.

## 12. `.git` preservation

The `.git` directory embedded in the uploaded ZIP was treated as the authoritative source. Each path, size, and SHA-256 value was compared individually.

- Regular files under `.git`: `28`
- Original `.git` manifest SHA-256: `def4035c5d75c673656e4d3e836d921e07a7374a011eebf460a366f22a7d26c4`
- `.git` deletion, reinitialization, or commit: none
- The final package is rechecked against the original bytes at the same paths after extraction.

## 13. Final assessment

The reproduced attachment-position permanent-loss window is closed in the corrected implementation.

- Stale SQL snapshots no longer overwrite acknowledged Yjs positions.
- Server-authoritative attachment content and metadata remain preserved.
- A new SQL attachment is adopted only when it is absent from Yjs.
- Tombstones and invalid parents fail closed.
- Old HTTP and WebSocket writers are blocked by the protocol fence.
- Dependency-free verification passes for the existing ten loss defenses and the new 11th defense.

Full dependency, live-browser, and MariaDB integration testing was not completed because of the limitations in section 9 and remains required before production deployment.
