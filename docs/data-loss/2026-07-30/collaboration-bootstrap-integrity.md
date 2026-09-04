# BrainVault data-loss deep audit — initial Yjs collaboration bootstrap integrity

- Audit date: 2026-07-30 (Asia/Seoul)
- Scope: 206 regular files in the uploaded `BrainVault.zip` working tree and the preserved `.git` directory
- Baseline Git HEAD: `243fba624c107dcf452fc9a7dcfcba86f9c9350b`
- Finding: **High — possible permanent loss of all page blocks**
- Remediation status: complete

## 1. Conclusion

This follow-up audit identified and corrected a serious integrity defect in which **the first Yjs document persisted when collaboration was enabled could differ from the authoritative SQL page**.

Before the correction, the first WebSocket client update was inserted into `page_yjs_updates` when the Yjs binary was structurally valid and within size limits. The server did not compare that first document semantically with the current SQL page inside the same transaction. Even if the document was stale or omitted blocks during initialization, it could become the initial durable collaboration state. Later server-authoritative materialization interpreted non-attachment blocks absent from Yjs as deletion intent and executed `DELETE FROM blocks`, potentially deleting part or all of a valid SQL page permanently.

The deterministic reproduction began with two authoritative SQL blocks. A syntactically valid candidate containing only the title and zero blocks became the first durable update, after which materialization reduced the relational block count **from 2 to 0**. After the correction, the same candidate is rejected before log insertion and both SQL blocks remain.

The audit also retraced persistence, deletion, backup/restore, attachments, page/block hierarchy, browser temporary recovery, Yjs materialization, and multi-process checkpoint paths. No separate new Critical or High permanent-loss path was identified beyond this finding. This is not a mathematical proof of absence and remains subject to the environment limitations below.

## 2. Vulnerable path

### 2.1 First share creates a new collaboration generation

When the first collaborator is added, existing `page_yjs_updates` and `page_collaboration_state` are removed and a new document epoch is created. At that moment, the authoritative content exists only in SQL `pages` and `blocks`.

### 2.2 First client selected as bootstrap leader

When the durable Yjs log is empty, the server sends `bootstrap: true` to the first connected client. That client builds a Yjs document from the page returned by the session API and sends a full-state update.

### 2.3 Missing validation before the correction

The old server checked only:

- Whether the Yjs binary could be decoded
- Document and update size limits
- Process-local room versus database update-ID checkpoint
- Collaboration access and document epoch

It did not enforce the core invariant:

```text
initial durable Yjs state == SQL page + every block locked in the same transaction
```

An empty or partial document could therefore become the initial durable log as long as it was valid Yjs.

### 2.4 Destructive effect of later materialization

Server-authoritative materialization constructs `activeIds` from block IDs present in the Yjs document and deletes existing non-attachment rows that are absent. This is correct deletion semantics after normal collaborative editing. If the first document is not a complete copy of the SQL authority, however, the server cannot distinguish **omission from intentional deletion**.

## 3. Reproducibility verification

Added command:

```bash
npm run reproduce:bootstrap-loss
```

Core result:

```json
{
  "vulnerable": {
    "firstYjsUpdateSemanticallyComparedWithSql": false,
    "incompleteCandidateIsSyntacticallyValid": true,
    "durableHistoryAccepted": true,
    "relationalBlockCountBeforeMaterialization": 2,
    "relationalBlockCountAfterMaterialization": 0,
    "permanentLossWindowReproduced": true
  },
  "fixed": {
    "firstYjsUpdateSemanticallyComparedWithSql": true,
    "bootstrapAccepted": false,
    "missingBlockCount": 2,
    "relationalBlockCountAfterRejectedBootstrap": 2,
    "permanentLossWindowClosed": true
  }
}
```

The reproducer inspects the pre-fix `src/lib/collaboration-server.ts` stored at the current Git `HEAD` and the corrected working-tree version. It deterministically confirms that the vulnerable implementation lacked semantic comparison and proceeded directly to the first insert, that later materialization deleted omitted blocks, and that the corrected implementation rejects the same candidate before persistence.

## 4. Correction

### 4.1 Atomic comparison of SQL authority and the first Yjs document

The first-update path in `src/lib/collaboration-server.ts` now performs:

1. Lock the page row with `FOR UPDATE`.
2. Lock and verify collaboration state and document epoch.
3. Verify that the durable update ID is exactly 0.
4. Lock every block row for the page with `FOR UPDATE` in the same transaction.
5. Materialize the candidate Yjs document on the server.
6. Compare it for complete semantic equality with the SQL authority.
7. Insert into `page_yjs_updates` only when they match.
8. On mismatch or decode failure, end the transaction without changes.

This ordering also closes the race in which a direct edit occurs after the session response. The first candidate then differs from the newly locked SQL authority, is rejected, and a new session retrieves the current state.

### 4.2 Semantic-equivalence validator

The new `src/lib/collaboration-bootstrap.ts` compares:

- Page title
- Exact set of block IDs
- Type
- Raw markdown
- Checked state
- Parent block ID
- Sort order
- Complete metadata structure and values
- Absence of attachment tombstones in the initial document

Metadata comparison uses a canonical signature that ignores object-key order while preserving array order and every actual value. Invalid JSON, non-finite numbers, dangerous prototype keys, excessive depth or node count, and unsupported sort orders fail closed rather than being normalized into acceptance.

### 4.3 Safe browser rebootstrap

When the server rejects the initial document with close code `4012`, the browser retries automatically only when:

- The startup document has not been acknowledged.
- No separate local recovery record exists.
- No recovery state needs preservation.

In that case only the unconfirmed in-memory `Y.Doc` is discarded, and a new collaboration session rebuilds from SQL authority. If any local recovery exists, the client remains offline and preserves it instead of automatically discarding it.

### 4.4 Minimal logging

Mismatch logs include only page/user identifiers and counts of missing, added, or changed fields. They do not record title, body, or metadata content.

## 5. Core invariants after the correction

```text
successful first page_yjs_updates INSERT
  ⇒ candidate Yjs materialization is semantically identical to
     pages.title and every block locked in the same database transaction

mismatched, incomplete, or malformed first candidate
  ⇒ unchanged Yjs log + unchanged SQL page + authoritative state refetch

first-candidate rejection with local recovery to preserve
  ⇒ no automatic discard + recovery data retained
```

The commutative, associative, and idempotent properties of Yjs updates guarantee merge and convergence for an already selected CRDT state. They do not decide **which initial state the application should authorize as canonical**. The SQL-to-Yjs transition therefore requires a separate application-level semantic check.

## 6. Regression tests and full revalidation

### 6.1 New tests

- `tests/collaboration-bootstrap-integrity.node.test.mjs`
  - Accept complete equality
  - Ignore block/object key ordering
  - Reject missing candidates
  - Reject changed or extra blocks
  - Reject attachment tombstones
  - Reject title mismatch
  - Fail closed on damaged SQL metadata
- `scripts/reproduce-collaboration-bootstrap-loss.mjs`
  - Demonstrates both the pre-fix loss window and the post-fix block
- Integrated source wiring and reproduction checks into `verify:collaboration` and `verify:data-loss`

### 6.2 Execution results

```text
lockfile registry check:                 PASS
new bootstrap-loss reproduction:         PASS (2 blocks → 0; fixed path keeps 2)
Node durability tests:                   28/28 PASS
collaboration-integrity verifier:        PASS (including syntax/wiring for 150 files)
data-loss guards:                        PASS
isolated strict TypeScript check:        PASS
all existing loss reproducers:           7/7 PASS
```

Revalidated loss models:

- Forged collaboration materialization
- Initial collaboration bootstrap
- Cross-instance stale room/compaction
- Browser recovery-write failure
- Republished stale SQL attachment position
- Structured-metadata automatic truncation
- Block sort-order overflow

### 6.3 Execution-environment limitations

The sandbox could not complete full `npm ci`, `npm run build`, the Vitest integration suite, or live MariaDB crash/race injection.

- The forced internal npm mirror returned `404` for `yjs@13.6.31` and other lockfile packages.
- Direct DNS access to the public npm registry was blocked.
- No MariaDB server or client was installed.
- A global `tsc` full-project check stopped during initialization because `@types/node` and `vitest/globals` were not installed.

These are explicit verification gaps. In the actual development or deployment environment, run:

```bash
npm ci
npm run check
```

Recommended live MariaDB race tests:

1. Inject a direct SQL/API edit immediately after the initial collaboration-session response.
2. Have a stale tab and current tab submit first WebSocket candidates concurrently.
3. Terminate the database connection immediately before and after the first insert.
4. Have multiple Node processes create an update-ID-0 room concurrently.

## 7. Changed files

- `src/lib/collaboration-bootstrap.ts` (new)
- `src/lib/collaboration-server.ts`
- `public/collaboration.js`
- `tests/collaboration-bootstrap-integrity.node.test.mjs` (new)
- `scripts/reproduce-collaboration-bootstrap-loss.mjs` (new)
- `scripts/verify-collaboration.mjs`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- This audit report

## 8. `.git` preservation verification

Path, size, and SHA-256 manifests were generated for all 28 regular files under `.git` before and after the correction. The manifests were identical, and their own SHA-256 was:

```text
21a0e87c2917da7bb41f26cbdb94569aad6e3c652e13c815fe791ad75ca06e7c
```

The final ZIP was extracted into a separate directory and checked again so that `.git` and all regular project files matched the modified tree. A ZIP SHA-256 was recorded alongside the original deliverable in a sidecar file.

## 9. Official technical references

- Yjs Document Updates: https://docs.yjs.dev/api/document-updates
- Yjs README / `encodeStateAsUpdate`
- MariaDB `FOR UPDATE`: https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/for-update
- MariaDB transactions: https://mariadb.com/docs/server/reference/sql-statements/transactions
- MariaDB `START TRANSACTION`: https://mariadb.com/docs/server/reference/sql-statements/transactions/start-transaction
