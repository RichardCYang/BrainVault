# BrainVault data-loss integrity deep audit and correction report

> **Follow-up notice:** A later independent review identified and corrected an 11th Critical defect in which an acknowledged attachment position could be reverted by a stale SQL snapshot. See [Attachment-position integrity](attachment-position-integrity.md) for the latest conclusion.

Audit date: 2026-07-29 (Asia/Seoul)  
Baseline commit: `3b2cc823a20e092ecb4258d93347d9232c48f072`  
Scope: complete uploaded `BrainVault.zip` source and preserved Git metadata

## 1. Final conclusion

The uploaded project already contained defenses for the nine critical data-loss findings from the 2026-07-28 audit. This audit revalidated their wiring and reproduction scripts and then reproduced an independent **10th critical integrity vulnerability** at the browser-storage failure boundary.

The vulnerable implementation exposed a user's edit in the UI or live Yjs document before writing a browser recovery copy. A failed `localStorage.setItem()` caused by quota exhaustion, disabled site storage, storage faults, or preservation of an unreadable existing record was not treated as a commit precondition. If the network disconnected before durable server acknowledgement and the tab or renderer then terminated, the newest edit could exist neither on the server nor in browser recovery and be lost permanently.

Severity: **Critical**

The correction enforces this invariant:

> An edit may be visible to the user or eligible for server transmission only when a browser recovery copy containing that edit has already been persisted, or when the server has already confirmed durable storage.

Collaborative edits are now prepared in a separate Yjs staging document. The complete recovery snapshot must be stored successfully before the incremental update is applied to the live document. For direct title and block edits, failure to persist the local draft prevents network transmission and restores the UI to the last durable state. A secondary path in which an old autosave timer could later transmit an already rejected block edit was also blocked.

## 2. Audit scope and method

The review traced how data is created, persisted, acknowledged, and deleted across:

- Browser direct drafts for page titles, block content, and block order
- Browser Yjs recovery snapshots and WebSocket acknowledgement handling
- Incremental Yjs updates, snapshot compaction, and relational materialization
- Page/block deletion, archive, sharing transitions, and full restore
- Attachment claim, `fsync`, and cleanup after database commit
- Multi-tab Web Locks and propagation leases
- Durable-room freshness across multiple application instances
- Damaged recovery records, document generations, and source-ID isolation

Verification combined:

1. Source-level state-machine review of persistence, transmission, acknowledgement, and deletion order
2. Dependency-free deterministic reproducer showing vulnerable and corrected sequences
3. Node built-in regression tests for the durability-before-visibility precondition
4. Reruns of existing materialization and cross-instance compaction loss reproducers
5. Wiring and syntax validation across all JavaScript and TypeScript source
6. Byte comparison between the original ZIP and modified working tree
7. Preservation verification using a per-file SHA-256 manifest for the original `.git`

## 3. Tenth critical vulnerability: edit exposed before recovery-write success

### 3.1 Vulnerable collaborative-edit order

The previous local-update sequence in `public/collaboration.js` was:

1. `setTitle()`, `upsertBlock()`, or a similar call mutated the live Yjs document immediately.
2. The Yjs `update` event made the newest edit visible in UI state and application memory.
3. The event handler wrote the complete document to browser recovery storage.
4. The live change remained even when the write returned `false`.
5. When the WebSocket was synchronized, the incremental update was sent.

If step 3 failed and step 5 failed or disconnected before server acknowledgement, the only copy of the new edit was volatile memory in the current tab.

### 3.2 Similar path for direct title and block edits

In direct mode, DOM input changed before `persistPageTitleDraft()` or `persistBlockDraft()` ran. Some critical callers ignored a `false` result and continued with state publication, autosave scheduling, or the API save path.

The same permanent-loss window existed when:

1. The user edited a title or block.
2. Local draft persistence failed.
3. The server request was not sent, or the connection failed before commit.
4. The tab, browser, or renderer terminated.
5. Reconnect restored only the older server value.

### 3.3 Conditions for permanent loss

All conditions had to coincide, but each belongs to a realistic failure combination:

- Browser storage write failure
  - Quota exhaustion
  - Site storage disabled
  - Browser policy or storage error
  - Collision with an unreadable existing record that the application must preserve
- Network interruption or send failure before durable server acknowledgement
- Subsequent tab/process termination or page reload

The Web Storage contract permits `QuotaExceededError` when a new value cannot be stored and describes disabled storage as a valid failure condition. Recovery-write failure is therefore part of the normal API contract, not a theoretical assumption.

## 4. Deterministic reproduction results

Added command:

```bash
npm run reproduce:recovery-write-loss
```

Vulnerable-state result:

```json
{
  "liveBeforeCrash": "critical edit",
  "serverBeforeCrash": "before edit",
  "recoveryWriteSucceeded": false,
  "reloaded": "before edit",
  "permanentLossWindowReproduced": true
}
```

Injected storage failure after the correction:

```json
{
  "rejectedWithDurabilityError": true,
  "liveAfterRejectedEdit": "before edit",
  "serverAfterRejectedEdit": "before edit",
  "unprotectedEditBecameVisible": false,
  "permanentLossWindowClosed": true
}
```

Verified order on the successful storage and acknowledgement path:

```text
persist-full-recovery
→ apply-live-update
→ server-commit-and-ack
→ clear-recovery
```

A failed write does not expose an unprotected edit in the live document. On success, the complete recovery copy exists before the edit becomes visible.

## 5. Root cause

The root cause was treating recovery-write results as warning signals instead of prerequisites for committing an edit.

Yjs updates merge robustly with respect to ordering and duplication for updates that actually reach the participating stores. CRDT properties cannot recover an update that entered neither browser storage nor durable server history. This was not a merge conflict; the update itself could be absent from every durable store.

The old implementation violated:

```text
visible(edit) OR publishable(edit)
    ⇒ durable_browser_recovery(edit) OR durable_server_ack(edit)
```

The corrected order for a new edit is:

```text
prepare candidate
→ persist full recovery candidate
→ expose to live document/DOM
→ transmit
→ retain recovery until all local writes are ACKed
→ clear recovery
```

## 6. Implemented correction

### 6.1 Yjs staging document

`public/collaboration.js` adds `localMutationDoc`, separate from the live document.

- Before each local edit, missing live state is synchronized into the staging document.
- Title and block add/update/delete operations run in the staging document first.
- After mutation, the complete staging document is encoded as the recovery candidate.
- Incremental updates produced by the same transaction are retained as candidates for live application.
- If the mutator or encoding fails, the staging document is discarded so partial state cannot leak into a later edit.

### 6.2 Durability-first commit gate

A new `commitPreparedCollaborationMutation()` in `public/collaboration-durability.js` guarantees:

1. The full recovery candidate and live incremental update are non-empty.
2. The full recovery candidate is persisted.
3. The live update is applied only when persistence returned a non-empty recovery generation.
4. Storage failure becomes a dedicated error with code `COLLABORATION_RECOVERY_WRITE_FAILED`.
5. Even if live application throws, the recovery copy already exists.

The live document applies the update with `PREPARED_LOCAL_ORIGIN` so the event handler does not reprocess the already persisted update in the old apply-then-save order.

### 6.3 Unexpected live-apply failure

If browser recovery persistence succeeds but applying the update to the live Yjs document fails unexpectedly:

- The durable recovery copy is retained.
- The staging document is discarded.
- The session enters `needsRecovery`.
- Ready/synchronized state is cleared.
- The WebSocket is closed so the next connection reapplies durable recovery.

An exception between storage and live application therefore converges through recovery instead of data loss.

### 6.4 Fail-closed direct title and block edits

The direct-draft path in `public/app.js` now:

- Does not publish a new title to page-summary state or the document tree before title-draft persistence succeeds.
- Rolls back the title revision and restores the last durable title on failure.
- Does not schedule a server request or autosave when block-draft persistence fails.
- Renders the failed DOM row from server state or the previous durable draft.
- Rolls back promotion state when cloning a conflict draft to the current tab source fails.
- Shows collaboration durability errors through the same local-storage failure message.

### 6.5 Removal of precommitted in-memory state

The following edits no longer mutate application state before storage succeeds:

- Callout type
- Text-alignment metadata
- Collaborative drag reordering

Metadata candidates are built from rendered-row datasets and controls. State is updated from a snapshot only after durable storage or collaboration commit succeeds. Failed collaborative reorder restores the prior order and rerenders.

### 6.6 Blocking delayed transmission of a rejected edit

Replacing a DOM row after storage failure was not sufficient when an autosave timer still captured the old row. If storage later recovered, that timer could send an edit the user had already been told was rejected.

Durable-state restoration now immediately removes, for the affected block ID:

- `blockSaveTimers`
- `blockSaveRows`
- Scheduled timeouts

An earlier durable edit already in flight is not canceled. Only the rejected newest DOM change is prevented from being transmitted later.

## 7. Added and changed files

- `public/collaboration-durability.js` — new durability-first commit gate
- `public/collaboration.js` — Yjs staging and fail-closed application
- `public/app.js` — direct-draft rollback, removal of precommit state, and stale-timer blocking
- `scripts/reproduce-collaboration-recovery-write-loss.mjs` — vulnerable/corrected state reproducer
- `tests/collaboration-durability.node.test.mjs` — five dependency-free regression tests
- `scripts/verify-data-loss-guards.mjs` — static invariant and reproduction integration
- `package.json` — reproduction and test commands
- This report
- Documentation index

`package-lock.json` and dependency versions were not changed.

## 8. Regression tests and execution results

### 8.1 New unit tests

Command:

```bash
npm run test:durability
```

Result:

```text
tests 5
pass 5
fail 0
```

Coverage:

1. A `null` recovery save prevents live application.
2. A storage exception is retained as the cause and prevents live application.
3. The full recovery candidate is stored before live application.
4. Recovery is already durable when live application fails.
5. Empty updates are rejected before storage or application side effects.

### 8.2 New reproducer

```text
vulnerable.permanentLossWindowReproduced=true
fixed.storageFailure.rejectedWithDurabilityError=true
fixed.storageFailure.unprotectedEditBecameVisible=false
fixed.success.durableBeforeVisible=true
fixed.permanentLossWindowClosed=true
```

### 8.3 Existing critical-loss reproducers

`reproduce-collaboration-materialization-loss.mjs`:

```text
vulnerable.permanentLossWindowReproduced=true
fixed.legacyCheckpointRequiresRematerialization=true
fixed.permanentLossWindowClosed=true
```

`reproduce-cross-instance-compaction-loss.mjs`:

```text
vulnerable.permanentLossWindowReproduced=true
fixed.staleNormalWriteRejected=true
fixed.staleRoomInvalidated=true
fixed.permanentLossWindowClosed=true
```

### 8.4 Complete dependency-free guard

```text
[verify-data-loss-guards] OK: durable-before-visible browser edits, destructive ordering,
server-authoritative collaboration materialization, cross-instance durable-room freshness fencing,
provenance-fenced checkpoints, owner-scoped atomic browser exclusion,
expiry-safe transition fencing, cross-tab recovery isolation,
lossless malformed-record handling, seven locale messages,
boundary-safe convergent storage snapshots, and fail-closed recovery inspection.
```

### 8.5 Collaboration and source syntax verification

```text
[verify-collaboration] OK: source wiring, exact Yjs dependency pins,
recovery acknowledgement safety, document-lineage isolation,
server-authoritative materialization provenance,
cross-instance durable-room freshness, hierarchy invariants,
RFC 6455 protocol behavior, and syntax for 134 file(s).
```

### 8.6 Lockfile verification

```text
[lockfile-registry] OK: 347 resolved URL(s) use approved portable registry hosts.
```

## 9. Revalidation of the previous nine critical defenses

The correction was reviewed alongside the existing defenses for:

1. Old-generation Yjs recovery merging into a new document after page-ID reuse
2. Destructive deletion, archive, or restore while another tab has a durable draft
3. Treating recovery-storage inspection failure as an empty, safe state
4. A recovery tab overwriting the original tab's source key
5. Rewriting a partially damaged recovery record in shortened form and mishandling an existing empty string
6. Treating a non-atomic `localStorage` lease as a mutual-exclusion lock
7. Removing an expired lease and reopening editing while the Web Lock is still held
8. Assuming the newest Yjs update ID authenticates a separate browser-supplied materialization payload
9. A stale multi-instance room compacting incomplete state into the newest snapshot

Destructive page/block operations, attachment commit boundaries, and export/restore journal and fingerprint paths were also retraced. No additional uncorrected Critical data-loss path was found beyond the tenth issue, subject to the execution limitations below.

## 10. Unexecuted verification and limitations

A clean dependency installation could not complete because the environment's npm package gateway did not provide tarballs referenced by the existing lockfile, and public-registry DNS access was blocked.

The following were not run:

- `npm run build`
- Full Vitest suite
- Live-browser integration with injected quota/storage-disable failures
- End-to-end transaction testing against MariaDB

To compensate, the new commit gate was isolated in a dependency-free pure module, tested directly with Node's built-in runner, and integrated into full source wiring plus three permanent-loss state-machine reproducers. Before deployment, run in an environment with a normal npm registry, supported browsers, and MariaDB:

```bash
npm ci
npm run build
npm test
npm run db:migrate
```

## 11. Deployment and operational guidance

- Retain the deployment conditions from the 2026-07-28 audit.
- Do not run old collaboration writers and the corrected version concurrently.
- Drain and stop all old processes before starting the corrected version.
- Apply migrations 021 and 022 before serving application traffic.
- Refresh old browser tabs without deleting browser recovery storage.
- When a storage-failure message appears, the edit was intentionally not applied. Restore browser storage/quota availability and enter it again.
- For multiple application instances, add shared pub/sub and distributed room coordination instead of process-local fan-out.
- An edit that lost every durable copy under an older vulnerable version cannot be reconstructed from the current database alone. Preserve backups and recovery data from each user's browser.

## 12. `.git` preservation verification

The authoritative comparison baseline was the `.git` bytes inside the uploaded ZIP, not the extracted working tree. Because even read-only Git operations can update index stat-cache fields, a SHA-256 manifest was calculated directly for the 28 files in the archive and compared with the final state. One extracted `.git/index` differed after Git inspection; it was restored from the original bytes at the same path **without deleting or recreating `.git`**.

- Regular files under `.git`: `28`
- Original archive `.git` manifest SHA-256: `816d6ea60ac0731bc4c79c18bb80b5cb3f16725cbc787dcc776937d1ae502f02`
- Final working-tree `.git` manifest: byte-for-byte match
- `.git` deletion, initialization, or commit: none

The final ZIP was extracted separately and its 213 regular files and 30 directories matched the working tree's byte manifest. The new tests, three reproducers, and two dependency-free verifiers were rerun from the extracted copy, after which the `.git` manifest still matched the original archive.

## 13. Final assessment

The newly reproduced permanent-loss window is closed in the corrected implementation.

- A failed storage write prevents an edit from entering the live Yjs or server-send path.
- Direct-edit UI is restored to the last durable state.
- On success, a complete recovery copy is stored before live exposure.
- Recovery remains until server acknowledgement.
- A stale autosave cannot later transmit a rejected block change.
- Reproducers and source guards for the previous nine defenses continue to pass.

Full dependency installation and real browser/MariaDB integration testing were not run because of the environment limitations and remain mandatory before production deployment.

## 14. Standards and official documentation

- WHATWG HTML Living Standard, Web Storage
- Yjs official documentation, Document Updates
- W3C Web Locks API
- MariaDB documentation, `START TRANSACTION` / `COMMIT`
