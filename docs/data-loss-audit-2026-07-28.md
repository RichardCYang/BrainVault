# Data-loss audit: critical persistence and recovery paths

Audit date: 2026-07-28 (Asia/Seoul)

## Executive finding

A critical cross-generation recovery bug could merge an obsolete offline Yjs document into a deliberately replaced page that reused the same page ID. The affected replacement paths included full workspace restore and disabling then re-enabling collaboration. Depending on the stale document state, this could resurrect old blocks, reapply old deletions, replace a restored title, or materialize an obsolete document over the restored relational page.

The fix introduces a server-issued `documentEpoch` as a generation fence and applies it consistently to session issuance, signed WebSocket tickets, in-memory rooms, every durable Yjs write, relational materialization, browser recovery keys, and manual recovery grouping. It also requires a generation-aware client capability marker before issuing a new session, so a browser tab running the pre-fix JavaScript cannot reconnect and replay a legacy recovery record after deployment.

Severity: **Critical**

A follow-up review of the direct-draft recovery path also found that a recovering tab could edit through the original tab's `localStorage` source key before the user confirmed a conflict. That defect and its correction are documented as the fourth critical finding below.

A final browser-durability review found a separate destructive-overwrite path: the direct-draft parser silently discarded malformed title, block, or order fragments while accepting the rest of the record, and the next edit rewrote the shortened record over the original bytes. All three durability stores also treated an existing empty-string value as if the key were absent. The fifth critical finding documents the lossless, fail-closed correction.

The same review found that destructive cross-tab transitions still executed when the browser Web Locks API was unavailable, relying on a non-atomic `localStorage` lease as the only exclusion mechanism. A delayed contender could overwrite the active lease, later remove it while the first destructive operation was still running, and reopen editing after the first operation had already completed its recovery preflight. The sixth critical finding documents the fail-closed, owner-scoped lock correction and a related storage-snapshot signature collision.

A further expiry-focused review reproduced a separate fence-loss path even when Web Locks were available. If lease renewal failed or a background timer was delayed, any reader treated the expired `localStorage` record as stale, deleted it, and reopened ordinary editing while the destructive callback still held its authoritative Web Lock. The seventh critical finding documents the expiry-safe correction: expiry remains a visible editor fence until a contender proves the authoritative Web Lock is free. Storage read and decode failures now also keep editing locked instead of being interpreted as an absent transition.

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

## Second critical finding: destructive direct-mode transitions

A separate cross-tab defect was found in the direct (non-Yjs) editor path. Permanent page/collection deletion, page archiving, and full workspace restore waited for the transition lease and rejected pending Yjs recovery, but did not reject durable per-tab direct-edit drafts. Server deletion snapshots, restore fingerprints, and optimistic row versions cannot represent an edit that has only reached another tab's `localStorage`. On a slow or offline connection, one tab could therefore delete, archive, or replace workspace data while another tab still held an unsaved title/block/order draft. The bytes remained available only through manual conflict/orphan-recovery JSON after the live page or block disappeared or was replaced, which is not a safe successful-save outcome. Direct block deletion had the same detach-to-orphan failure mode.

The client now:

- checks all source-tab direct drafts for every page in a permanent deletion scope before issuing the destructive API call;
- checks direct drafts before archiving a page or replacing the workspace from a backup;
- performs direct block deletion inside the existing page transition lease, lets other tabs flush, and rejects deletion while another source still has a draft or order record for the affected block subtree; and
- preflights empty-block deletion and attachment replacement before their preparatory structural work.

Severity: **Critical**

## Third critical finding: browser recovery inspection failed open

The direct-draft, collaboration-recovery, and page-transition stores enumerated `localStorage` by numeric index three times and merged the keys they observed. That reduced a simple one-removal index-shift race, but it was still a bounded, non-atomic scan. A reproducible four-record schedule can remove one earlier key near the end of each pass, shift the final surviving record into an index already visited, and leave that survivor unseen after all three passes.

The same code returned an empty key list when `storage.length` or `storage.key()` threw, and record loaders silently skipped JSON/schema/decode failures. Destructive guards therefore could not distinguish “there are no unsaved bytes” from “the browser recovery store could not be inspected.” Permanent deletion, archive, workspace restore, sharing transitions, or direct block deletion could proceed while a surviving or undecodable recovery record still existed. The transition lock had an additional failure-open edge: an unreadable lease was treated as absent and could be overwritten by a new destructive transition.

### Reproduction before the fix

1. Store four records in insertion order: `A`, `B`, `C`, and `survivor`.
2. During pass 1, remove `A` after index 2 is returned; `survivor` shifts from index 3 to index 2, which has already been visited.
3. During pass 2, remove `B` after index 1 is returned; `survivor` again shifts into a visited index.
4. During pass 3, remove `C` after index 0 is returned; `survivor` remains stored but is never returned by the three-pass forward-only snapshot.
5. The old guard receives `[]` after it tries to read the now-removed observed keys and incorrectly permits the destructive operation.

A separate deterministic probe makes `storage.length` throw. The old implementation catches that exception and also returns `[]`, producing the same unsafe decision.

### Implemented correction

- Added a shared `public/storage-snapshot.js` implementation used by all three browser durability stores.
- Each pass scans both forward and reverse, retains the union of every observed key, and only marks the snapshot reliable after three consecutive complete, identical passes. It makes up to 64 passes; failure to converge is an explicit unreliable result rather than an empty set.
- Added inspection APIs that return `{ records, reliable, unreadableKeys }` for direct drafts, Yjs recovery records, and active transitions.
- Destructive application guards now reject the operation whenever enumeration is unreliable or a target recovery record is present but undecodable.
- Workspace and page transition preflight now inspects durable leases safely before and after propagation. An invalid lease is preserved for diagnosis, treated as occupied/unsafe, and never overwritten by `acquire()`.
- Direct draft cleanup and collaboration recovery acknowledgement no longer report success when their key snapshot cannot be proven stable.
- Added localized user-facing fail-closed messages for all seven supported languages.

Severity: **Critical**

## Fourth critical finding: recovered drafts overwrote the origin tab's recovery key

The direct editor correctly generated an in-memory source ID per live tab, but conflict recovery bypassed that isolation. When tab B selected a title or block draft written by tab A, the recovered editor row used tab A's `sourceId` as its live write target. Title input handling and block dirty tracking persist a draft before displaying or completing the overwrite confirmation. As a result, merely typing in tab B could replace tab A's durable recovery record with tab B's content. Cancelling the overwrite prompt did not restore the original bytes.

Recovered block-order retries had the same ownership flaw: the retry task retained the origin source key. A fresh mutation ID issued after a server mutation-ID collision could therefore rewrite the origin tab's order-recovery record.

### Reproduction before the fix

1. Tab A edits a page while its network save is pending or unavailable. Its title or block draft is stored under source `A`.
2. Tab B opens the page, selects A's recovery record, and encounters an optimistic-version conflict.
3. The recovered title or block is activated with source `A` instead of B's source.
4. Tab B types. The normal pre-network durability write updates source `A` before conflict confirmation finishes.
5. If the user cancels, closes tab B, or tab A remains active, A's last independent recovery copy has already been silently replaced.

### Implemented correction

- Every recovered title, block, and block-order retry is first cloned to the current tab's source ID. Live editing and retry mutation-ID changes only touch that clone.
- The origin title/block record is retained as an immutable exact-match cleanup snapshot. It is never refreshed from storage, because doing so could absorb a concurrent edit made by the origin tab and later delete that newer edit.
- Conflict rendering prefers the current-tab clone and uses origin content only as a read-only fallback while keeping the live write source assigned to the current tab.
- Successful title/block saves remove the origin record only when value/payload, expected version, and revision still match the activation snapshot.
- Successful block-order replay acknowledges the current clone and then removes the origin only when its original mutation ID is unchanged.
- Added static guards and store-level regression cases for title, block, and order source isolation.

Severity: **Critical**

## Fifth critical finding: malformed browser recovery was silently shortened or overwritten

The direct-draft store used a permissive normalizer. If one title, block, or block-order fragment failed validation while another fragment remained valid, the record was returned as readable with only the valid pieces. `saveTitle`, `saveBlock`, and `saveBlockOrder` then serialized that shortened object back to the same `localStorage` key. A single partially written, future-schema, or otherwise damaged component could therefore be permanently removed from the browser's last recovery copy by an unrelated next edit.

A fully undecodable exact-source record had a second overwrite path: the save functions used `loadPage(...) ?? createRecord(...)`, so a parse failure looked identical to a missing record and the newly created record replaced the raw value. In addition, the direct-draft, collaboration-recovery, and transition-lock stores checked `if (!raw)`. The Web Storage contract reserves `null` for a missing key; an existing empty string is still a present value. The old checks consequently treated an empty recovery record as safely absent. Direct and Yjs recovery saves could overwrite it, while a destructive transition could overwrite an empty but unknown lease.

### Reproduction before the fix

1. Write a schema-v2 direct-draft record containing a valid title and a malformed block payload under the current tab's source key.
2. Load the page. The old parser accepted the title, silently omitted the malformed block, and reported no unreadable key.
3. Edit the title or another block. The normal pre-network durability save serialized the shortened record to the same key.
4. The original malformed block bytes, which may still have been recoverable by a newer build or forensic inspection, were destroyed.
5. The same overwrite was reproducible by storing `""` at an exact direct-draft or Yjs recovery key. For transition locks, `""` was treated as no lease and allowed a second destructive operation to acquire the key.

### Implemented correction

- Direct-draft parsing is now lossless for payload-bearing fields: any present but invalid title, block, or block-order component makes the whole raw record unreadable. No fragment is silently dropped.
- Parsed record identity must match the encoded user/page/source key. Yjs recovery identity must likewise match account/page/epoch/source and legacy/current key shape.
- Only `raw === null` means a key is absent. Empty strings and every other undecodable present value are preserved and reported as unsafe.
- Every direct-draft mutation, acknowledgement, exact-match cleanup, page removal, and bulk clear refuses to modify an unreadable target. `writePage` re-inspects the key immediately before replacement or removal.
- Yjs recovery saves preflight their exact target key and refuse to overwrite unreadable or identity-mismatched bytes.
- Transition inspection and owner release treat an empty value as invalid rather than missing, so `acquire()` cannot replace it.
- Added regression coverage for partial component damage, empty-string values, key/content identity mismatch, failed cleanup, and byte-for-byte preservation.

Severity: **Critical**

## Sixth critical finding: a durable localStorage lease was mistaken for atomic cross-tab exclusion

The page-transition helper used the browser Web Locks API when available, but its fallback executed the destructive action immediately and relied only on a `localStorage` lease. Lease acquisition was a multi-step read/check/write/verify sequence. Web Storage provides no compare-and-set operation or cross-tab lock around that sequence, so two tabs could both observe a missing lease and later verify different writes to the same key. The existing 50 ms propagation delay and one-time ownership check reduced common races but could not close a delayed-contender schedule.

This affected safety-critical persistence-mode transitions including permanent deletion, page archive, sharing enable/disable, direct block deletion, and full workspace restore. The server-side optimistic and transaction guards still protect many row-level conflicts, but they cannot represent a direct edit that is created in another tab after the destructive operation's local recovery preflight.

### Reproduction before the fix

1. Tabs A and B both complete the outer preflight while the transition key is absent.
2. Inside `acquire()`, both tabs read the key as missing. Tab B is then suspended before its write.
3. Tab A writes and verifies lease A, waits for propagation, verifies ownership, and starts a slow destructive operation such as workspace restore or permanent deletion.
4. Tab B resumes from its stale read, overwrites the key with lease B, verifies it, waits, and starts its own transition. Tab A is not re-fenced while its action is in progress.
5. Tab B finishes first and removes lease B. Other tabs now observe no transition and can resume editing or create new durable drafts even though tab A is still running and has already completed its draft/recovery checks.
6. Tab A later commits deletion or replacement. The newly created local draft is detached from the live page/workspace and survives only as orphan recovery data rather than as a successful save.

A related fail-closed defect existed in storage snapshot stabilization. Key sets were joined with NUL to form a signature, so the distinct legal key sets `["a\u0000b"]` and `["a", "b"]` produced the same signature. Concurrently changing storage could therefore be declared stable after three delimiter-colliding complete passes.

### Implemented correction

- `runExclusive()` now refuses to call the action when `navigator.locks.request` is unavailable and returns the explicit reason `lock-manager-unavailable`. No destructive network or database mutation is attempted.
- Page-level and workspace-level transitions for one owner now use the same owner-scoped Web Lock resource. Page-specific durable leases remain in place for propagation, editor locking, crash expiry, and recovery visibility, but are no longer treated as the authority for mutual exclusion.
- The client surfaces a localized fail-closed explanation in all seven interface languages.
- Storage snapshot signatures now JSON-encode the sorted key array, preserving string boundaries for every key value.
- Regression coverage proves that the destructive callback is not invoked without Web Locks, owner-scoped lock wiring is present, and alternating delimiter-colliding key sets never produce a reliable snapshot.

Severity: **Critical**

## Seventh critical finding: an expired propagation lease could disappear while its destructive Web Lock was still held

The owner-scoped Web Lock fixed atomic destructive-transition exclusion, but the durable propagation lease still had an unsafe expiry rule. `inspect()` automatically removed a valid lease as soon as `expiresAt` passed. A destructive callback can legitimately outlive that timestamp when a renewal write fails, a tab is background-throttled, the main thread is stalled, or the storage operation is temporarily unavailable. The Web Lock remains held until the callback settles, but ordinary editor input does not acquire that lock; it relies on the durable lease to know that editing must remain fenced.

### Reproduction before the fix

1. Tab A acquires the owner-scoped Web Lock and writes a page-transition lease with a one-second test TTL.
2. The destructive callback remains pending. At 400 ms, a simulated `localStorage.setItem()` failure makes the renewal return `null`; the original lease bytes remain present.
3. At 1,001 ms, tab B reads the transition. The old `inspect()` path sees `expiresAt <= now()`, removes the record, and reports the transition as missing.
4. Tab B still cannot start another destructive transition because tab A holds the Web Lock, proving that the destructive callback is active. However, the ordinary editor now sees no lease and can accept a new title, block, or order draft.
5. Tab A later commits deletion, archive, sharing-mode replacement, or workspace restore. The new draft was created after preflight and is detached from the live data.

The dependency-free reproduction produced this pre-fix result:

```json
{
  "initialLease": true,
  "renewalAfterStorageFailure": null,
  "rawLeaseSurvivedFailedRenewal": true,
  "destructiveWebLockStillHeld": true,
  "ordinaryEditorSeesTransition": false,
  "rawLeasePreservedForFence": false,
  "dataLossWindowReproduced": true
}
```

### Implemented correction

- Expiry is now a stale-candidate state, not permission for an uncoordinated reader to delete the record. `inspect()`, `read()`, and transition enumeration retain both active and expired valid leases as editor fences.
- Every new lease records its authoritative `exclusiveId`. Lease acquisition is rejected unless the helper is currently inside the matching Web Lock callback.
- `releaseExpired()` removes only an expired lease and only while the caller holds its authoritative Web Lock. A legacy lease without `exclusiveId` requires the page-scoped lock.
- Page transitions acquire both the page and owner-workspace Web Lock names in deterministic order. This preserves compatibility with earlier builds that used either scope and avoids deadlock.
- Renewal may extend the same expired token while its authoritative Web Lock is still held, covering delayed timers without briefly reopening the editor.
- The UI treats active and expired records as locked. Storage read/decode errors also fail closed. Expired records are reaped by a timed contender only after it obtains every required Web Lock; a blocked reaper retries instead of unlocking.
- Workspace transitions safely reap only expired page leases that explicitly identify the same owner scope. Ambiguous legacy records remain fail-closed rather than being guessed away.
- The storage-event path uses the same fail-closed inspection and flushes pending edits even when a transition record is unreadable.

The same schedule after the correction produced:

```json
{
  "initialLease": true,
  "renewalAfterStorageFailure": null,
  "expiredLeaseRemainsClassified": true,
  "ordinaryEditorSeesTransition": true,
  "rawLeasePreservedForFence": true,
  "unsafeReaperBlockedWhileWebLockHeld": true,
  "safeReaperSucceededAfterWebLockReleased": true,
  "dataLossWindowClosed": true
}
```

Severity: **Critical**

## Other audited data-loss surfaces

No further critical defect was identified in the following paths during this review:

- Direct title/block saves: durable per-tab drafts are written before network submission; recovered drafts are cloned to the current source before editing; optimistic versions and mutation request hashes prevent stale or ambiguous retries from silently overwriting newer content.
- Save coalescing: a failed/ambiguous write remains ahead of newer queued edits, so a newer edit is not sent against an unknown server version.
- Destructive transitions: archive, permanent delete, direct block deletion, final-share removal, and workspace replacement check pending local/collaboration state, use owner-scoped authoritative Web Locks, retain active or expired page/workspace leases as propagation fences, and reap expiry only after proving the corresponding Web Lock is free.
- Workspace restore and attachments: database replacement is transactionally fingerprinted; live collaboration rooms are invalidated before replacement; attachment generations use journals, checksums, fsync, and commit-outcome recovery.
- Block deletion/reordering: version snapshots, hierarchy locks, cycle validation, and idempotent mutation receipts prevent stale structure changes from being silently applied.

These findings are code-audit conclusions rather than a substitute for the unavailable full database/browser integration suite described below.

## Validation performed

Successful checks in the audit environment:

```text
npm run lockfile:check
[lockfile-registry] OK: 347 resolved URL(s) use approved portable registry hosts.

npm run verify:collaboration
[verify-collaboration] OK: source wiring, exact Yjs dependency pins, recovery acknowledgement safety, document-lineage isolation, hierarchy invariants, RFC 6455 protocol behavior, and syntax for 124 file(s).

npm run verify:data-loss
[verify-data-loss-guards] OK: destructive ordering, owner-scoped atomic browser exclusion, expiry-safe transition fencing, cross-tab recovery isolation, lossless malformed-record handling, seven locale messages, boundary-safe convergent storage snapshots, and fail-closed recovery inspection.

[dependency-free-js] passed=73 failed=0
[dependency-free-static-ui] passed=79 failed=0

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
- close code `4011` handling;
- JavaScript/TypeScript syntax for all scanned sources;
- destructive callbacks never running when the browser lock manager is unavailable;
- expired transition records remaining visible while the authoritative Web Lock is held;
- failed renewal preserving the raw lease and blocking an unsafe expiry reaper;
- expiry cleanup succeeding only after the authoritative Web Lock is released;
- delayed renewal extending the same expired token while its Web Lock remains held;
- page and workspace transitions sharing owner/page authoritative Web Locks in deterministic order;
- storage read or decode failures keeping the editor fail-closed;
- delimiter-colliding storage key sets being rejected as unstable;
- the exact repeated-index-shift counterexample that defeats the old three-pass forward scan;
- convergence and survivor visibility for direct drafts, Yjs recovery, and transition leases;
- unreliable storage enumeration being surfaced instead of converted to an empty result;
- undecodable target records and leases remaining preserved while destructive operations fail closed;
- recovered title and block activation always writing through the current tab's source;
- recovered block-order retries retaining an exact origin mutation token;
- current-tab edits leaving the origin tab's title, block, and order records unchanged;
- partially malformed direct-draft records being rejected without dropping valid or invalid fragments;
- empty-string direct-draft, Yjs recovery, and transition records being treated as present and unsafe;
- exact recovery-key identity matching encoded account/user, page, epoch, and source values; and
- failed writes, acknowledgements, and cleanup preserving the original raw bytes byte-for-byte.

## Environment limitation

A clean dependency installation was attempted repeatedly, including after the final patch. The configured package gateway returned HTTP 503 for the existing locked dependency `zod-3.25.76.tgz`, and the local npm cache did not contain it. Consequently the audit environment could not run the full TypeScript build, complete Vitest suite, or MariaDB integration suite after a clean install. A temporary dependency-free Vitest-compatible runner executed all 73 JavaScript unit tests across 10 files and 79 dependency-free TypeScript UI tests across 15 files; all 152 passed. The source verifiers additionally parsed all 124 scanned JavaScript/TypeScript files. No lockfile or dependency version was changed, and the temporary test shim was removed before packaging. Run the following in an environment with registry and MariaDB access before production deployment:

```bash
npm ci
npm run build
npm test
npm run db:migrate
```

## Deployment note

Apply migration 021 before serving the updated application. Force a full refresh or close/reopen every pre-fix browser tab during rollout: an already-running tab still has the old expiry behavior in memory even after the server files are replaced. A pre-fix browser tab will also be denied a new collaboration session until refreshed. Do not delete browser recovery storage during rollout; legacy and undecodable records are intentionally retained for manual recovery.

Serve production over HTTPS in a browser that exposes the Web Locks API. Safety-critical destructive transitions intentionally fail closed when that API is unavailable; normal direct editing and recovery storage remain available. Do not manually delete a transition record merely because its timestamp has expired: the updated client retains it until a contender obtains the recorded authoritative Web Lock and proves the original callback is no longer running.
