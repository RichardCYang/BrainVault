# Recovery maintenance review (2026-09-11)

Confirmed issue: a failed IndexedDB recovery write left newer text or binary
edits only in the synchronous mirror. A later explicit refresh or cross-tab
notification replaced that mirror with the older durable record, discarding the
remaining recovery copy. Conditional cleanup and legacy reconciliation could
also replace that mirror after a failed write.

The recovery adapter now tracks uncommitted writes by mutation generation.
Backing-store reconciliation preserves these values until the exact write
commits. Explicit deletion and clear remain supported; if either fails, the
unsaved value and its protection are restored. This retains the existing strict
transaction durability, atomic comparison, account/source key namespaces, and
legacy migration receipts. It does not add endpoints or HTML rendering paths.
A failed write still requires a successful retry before closing the tab; an
in-memory copy is not a durable backup.

Reproduction on the original version:

1. Persist an old draft with setItem and await flush.
2. Force the next strict IndexedDB write to fail, then write a newer text value
   with setItem or binary value with setObject. Observe flush rejecting.
3. Restore storage availability without retrying that write.
4. Call refresh, or deliver a peer recovery-change notification for the key.
5. Observe the old durable draft replacing the newer in-memory value. With this
   patch, the newer value survives and can be retried, persisted, and reopened.

Automated reproduction and regression command:

```sh
node --test tests/indexeddb-recovery-storage.node.test.mjs
```

Validation: all 54 recovery-storage tests passed, including 11 new regressions.
The four initial text/binary refresh reproductions failed on the original code
and passed after remediation. Four authenticated-cache isolation checks passed.
The npm build completed successfully. Selected Vitest suites yielded 55 passing
tests and two failing tests; both failures reproduced against the untouched
archive (foreign-source draft cleanup expectations and registration limiter
ordering). Three route/security suites could not initialize because this CI
runtime's os.networkInterfaces call raises a system error. Live MariaDB and
real-browser integration were not validated; this is not a claim that the entire
application is free of defects or vulnerabilities.

Review scope: recent Git history; browser recovery, draft acknowledgement and
save queues; database transaction durability; page/block deletion snapshots,
version checks, owner access checks, and mutation replay handling. The source
patch is confined to public/indexeddb-recovery-storage.js. Regression additions
are in tests/indexeddb-recovery-storage.node.test.mjs.

References consulted:
[IndexedDB transaction semantics](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction)
and [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

Packaging preserves every original archive entry and its project path. The
original .git ZIP members, including their compressed payloads and metadata, are
copied unchanged. Git inspection used Python subprocess with optional locks
disabled; no Git commits, index updates, or object-file parsing were performed.
Installed dependencies and generated build/test files are not included.
