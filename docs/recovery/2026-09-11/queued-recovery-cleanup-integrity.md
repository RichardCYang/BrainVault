# Queued recovery cleanup integrity (2026-09-11)

This maintenance change fixes a confirmed recovery-storage data-loss path. It
preserves the synchronous Storage-compatible mirror and serialized strict
IndexedDB writes used by the existing architecture. No server API, database
schema, authorization policy, or HTML-rendering behavior is changed.

### Architectural review

Git history through `6684510` establishes that unsynchronized text and binary
recovery drafts must survive failed writes, refreshes, and failed cleanup, while
successful acknowledgements must remain deleted. History was inspected through
Python subprocess calls to Git with `--no-optional-locks` and
`GIT_OPTIONAL_LOCKS=0`. The archive contains CRLF source files; ignoring end-of-line
whitespace is necessary when comparing their contents to the Git tree.

The principal reviewed boundaries were `public/app.js`, `public/save-queue.js`,
`public/draft-store.js`, `public/collaboration-recovery-store.js`,
`public/indexeddb-recovery-storage.js`, `src/lib/db.ts`, and the page/block routes.
The server uses transactional persistence, optimistic versions, authorization
checks, and mutation receipts. Permanent page deletion checks a locked subtree
snapshot before cascading deletion. The confirmed new issue is in the browser
recovery adapter, not a bypass of those server checks.

### Reproduction

1. Create recovery storage and persist `draft = "old durable value"`; await flush.
2. Inject an IndexedDB write failure, write `draft = "only unsaved copy"`, and
   observe flush rejection. The newer draft now exists only in memory.
3. Restore write-transaction admission, but inject failures for delete and clear.
4. Without awaiting between them, queue `removeItem("draft")` twice. The same
   issue occurs with delete/clear, clear/delete, and clear/clear.
5. Await flush rejection and inspect `getObject("draft")`. Before the fix it
   returns the older durable value, losing the only newer copy. Binary drafts
   have the same failure. This is a deterministic storage-adapter reproduction;
   it is not a claimed live-browser click-through reproduction.

Run the regression cases with:

```sh
node --test --test-name-pattern="failed queued|does not resurrect" tests/indexeddb-recovery-storage.node.test.mjs
```

All eight text/binary preservation cases failed against the original source
before patching. The complete storage suite passes after patching.

### Applied fix and security review

Consecutive delete/clear operations now share a rollback snapshot containing the
last recoverable value and its write-commit receipt. A successful removal marks
that shared snapshot as removed, preventing a later failure from resurrecting
acknowledged data. Clear operations now track per-key ownership so older rollback
work cannot overwrite later local intent. Failed cleanup restores uncommitted
protection, keeping flush rejection and pending-write unload guards active until
a durable retry or successful explicit removal.

The patch adds no network access, HTML sinks, credentials, or user-controlled
SQL. It retains existing recovery key isolation, cloning, cross-tab comparisons,
legacy migration receipts, and strict transaction completion checks. This is a
bounded code review, not a certification that the entire application is free of
IDOR, XSS, or other vulnerabilities.

### Validation

The production build passes. All 75 recovery-storage tests pass, including 16
new cases covering repeated failures and mixed success/failure cleanup ordering.
A broader Vitest comparison reports 307 passing and 27 failing tests on both
the patched project and a fresh extraction of the original. Both also have 36
suite initialization errors caused by this environment's
`uv_interface_addresses` failure. The durability suite reports 992 passing and
four failing tests in the patched tree; the original has the same four failures
(976 passing after supplying Git history to its history-dependent reproduction).
The failures cover restore receipt expectations, two structured metadata limits,
and theme-preference persistence. Those existing failures were not changed or
suppressed. Live-browser IndexedDB and live MariaDB integration are unverified.

An integrity comparison detected that the extracted `.git/index` changed during
tooling; the cause was not established. To prevent that workspace change from
entering the deliverable, final packaging starts from the untouched input ZIP
and replaces only the three explicitly patched files. The final ZIP preserves
all original project entries and the original `.git` archive members. Only this README, the recovery-storage module, and its regression
test file are replaced. Installed dependencies, build output, and diagnostic logs
are not added to the deliverable.

References: [Git optional-lock controls](https://git-scm.com/docs/git) and the
[IndexedDB transaction specification](https://w3c.github.io/IndexedDB/#transaction-concept).
