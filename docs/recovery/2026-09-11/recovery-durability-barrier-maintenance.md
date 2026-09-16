# Recovery durability barrier maintenance (2026-09-11)

This maintenance pass follows HEAD b6c39ff and its intent to retain unsynchronized
text and binary drafts after IndexedDB failures. Git inspection used read-only
Git CLI commands through Python subprocess with GIT_OPTIONAL_LOCKS=0. The archive
source differs from HEAD only in line endings before this patch.

### Confirmed defects and fixes

Concurrent flush callers shared one mutable failure acknowledgement. One caller
could consume the error and let another report success for the same failed
transaction. Each flush now captures its own failure observation boundary.

After a failed put, the queue drained while the only newer draft remained in
memory. Subsequent flush calls could succeed, and hasPendingWrites returned
false. The app uses that method in its before-unload protection. Both APIs now
continue reporting the unsaved condition until the draft is durably retried or
explicitly removed. Saving a different key or refreshing storage cannot clear it.

Queued delete/clear rollback snapshots now share per-write commit receipts. If a
preceding put commits while deletion is queued, a failed deletion does not restore
that already-committed generation as an uncommitted draft. Existing generation
fences continue protecting newer edits and explicit successful deletions.

### Reproduction and verification

1. With the existing FakeIndexedDb harness, initialize recovery storage, set
   ignoreDurability=true, and call setItem or setObject with an unsaved draft.
2. Start two flush calls together using Promise.allSettled. Before the patch,
   one rejects and one fulfills. Both must reject after the patch.
3. Call flush again and inspect hasPendingWrites without retrying the draft.
   Before the patch, flush fulfills and the guard is false. After the patch,
   flush rejects and the guard stays true. A different key's successful save
   must not change that result.
4. Restore strict durability and retry the same draft. Flush must succeed,
   the pending guard must clear, and reopening storage must recover the bytes.
5. Separately, persist a draft, inject a deletion failure, and start two flush
   callers after removeItem. Both must report the failure, and the durable draft
   must remain recoverable. This case has no outstanding failed put.
6. For rollback regression coverage, queue a put immediately followed by a
   failing removeItem or clear. The put commits first. After observing the
   deletion error, its restored durable value must not remain marked unsaved.

Run the focused suite with:

```sh
node --test tests/indexeddb-recovery-storage.node.test.mjs
```

Validation: all 59 focused tests pass, including five added cases. Four existing
parameterized cases now explicitly require flush to reject while a failed draft
remains uncommitted; their data-preservation assertions are retained. The build
passes. The broader durability run passes 976 of 980 tests; all four failures also
occur on the original archive. The original run has one additional failure in a
standalone reproduction. The unit runs report the same 307 passing and 27 failing
assertions on original and patched source; additional suite-loading failures and
sandbox network-interface restrictions prevent a clean full-suite result.
Existing failures were not suppressed or represented as passing.

The audit also inspected public/app.js, public/draft-store.js,
public/collaboration-recovery-store.js, src/lib/db.ts, and the page/block mutation
routes. The patch changes only local recovery bookkeeping and its tests, adding
no HTML rendering, network endpoints, SQL, or authorization bypass. Existing
account/source keys and atomic compare operations are retained. Live-browser
IndexedDB behavior and live MariaDB integration were not validated here; the
fault-injection harness is not a full browser transaction simulator.

Reference checks: IndexedDB transaction completion signifies successful commit
(https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event).
Object access must retain per-object authorization checks
(https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html).

The final archive retains the original entry structure and pristine Git archive
records. Only this README, public/indexeddb-recovery-storage.js, and its existing
test file are replaced. No dependencies, build outputs, or diagnostic logs are
added to the deliverable.
