# BrainVault collaborative block-deletion data-integrity deep audit

- Audit date: 2026-07-30
- Baseline Git commit: `46f8d825449c29ede71500391cb706e7046141d5`
- Scope: complete attached BrainVault source and `.git` history
- Focus: Yjs browser recovery, multi-tab deletion races, Web Lock transition fences, collaboration materialization, and attachment-block replacement

## Conclusion

A full review of the persistence paths found a **High-severity integrity defect that allowed a collaborative block to be deleted while another tab in the same browser still held a durable edit-recovery copy that had not yet received a server acknowledgement**.

Direct-mode block deletion already checked other tabs' direct drafts, and page archive, permanent deletion, and sharing disable already checked Yjs recovery. Collaborative block deletion alone called `session.deleteBlock()` directly and bypassed:

- Owner/page-scoped Web Locks and the `localStorage` transition lease
- Inspection of collaboration recovery saved by other tabs
- Waiting for peer-tab flushing before deletion
- Holding the transition lease until the delete update was acknowledged and materialized into SQL

If tab B's offline edit overlapped tab A's deletion, B's update could later be accepted by the server while remaining invisible because its top-level block key had been deleted. Once acknowledgement cleanup removed B's browser recovery, the user could also lose the explicit copy needed to recover the edit.

The correction unifies collaborative block deletion and replacement of an empty block with an attachment under the same destructive-transition path. It guarantees:

1. Pending Yjs updates in the current tab are flushed through acknowledgement and materialization before deletion.
2. The transition allows time for the storage event to reach peer tabs on the same origin.
3. Local collaboration recovery for the target page is inspected fail-closed, including records belonging to other accounts.
4. If any recovery remains, or storage inspection is uncertain, the delete action does not run.
5. When deletion is allowed, the Web Lock and lease remain held until the delete update is acknowledged and materialized into SQL.
6. Attachment upload no longer calls `session.deleteBlock()` directly when replacing an empty block.

## New defect: race between unacknowledged collaboration recovery and block deletion

### Severity

**High — user edits could become permanently invisible and their recovery copy could be removed**

Required conditions:

- At least two browser tabs on the same origin are open.
- The target page is in shared collaboration mode.
- One tab has durable Yjs recovery that has not yet been acknowledged by the server.
- Another tab deletes the same block or replaces an empty block with an attachment.

Impact:

- The other tab's edit can be accepted as a server update but remain invisible under a deleted block key.
- After acknowledgement removes local recovery, the explicit user recovery path can disappear.
- The delete request appears to succeed normally, making the loss difficult to notice immediately.
- Attachment upload used the same bypass when replacing an empty block.

### Root cause

The collaboration branch in `public/app.js` bypassed the project's destructive-transition and recovery policies:

```js
if (isCollaborativePage()) {
  const session = state.collaborationSession;
  if (!session?.isReady) throw new Error(t("sharing.syncRequired"));
  return {
    deletedIds: session.deleteBlock(blockId, {
      cascade: options.includeDescendants !== false
    })
  };
}
```

Direct-mode block deletion already used `withPagePersistenceTransition(pageId, "block-delete", ...)` and `assertNoPendingLocalBlockDrafts(...)`. Page archive, permanent deletion, and removal of the final share also used `assertNoPendingLocalCollaborationRecovery(...)`. Collaborative block deletion was the only destructive operation outside that policy.

Attachment upload contained another direct call when replacing an empty source block:

```js
session.deleteBlock(blockId, {
  cascade: false,
  allowDisconnected: true
});
```

That path relaxed both recovery inspection and synchronization-readiness checks.

## Reproduction

The project adds:

```bash
npm run reproduce:collaboration-block-delete-loss
```

The reproducer verifies three layers:

1. **Vulnerable state model**
   - Peer recovery exists, but deletion ignores it.
   - The recovery update is acknowledged after deletion.
   - Explicit recovery is removed.
   - The edited block remains invisible, establishing the loss window.

2. **Corrected state model**
   - Pending recovery is found.
   - Deletion is blocked before it runs.
   - The original block and recovery both remain.

3. **Actual source-order verification**
   - Owner/page Web Lock transition exists.
   - Peer flush occurs before recovery inspection.
   - `session.deleteBlock()` runs only after recovery inspection.
   - The lease is not released until `flushMaterialization({ compact: false })` completes after deletion.
   - The attachment-replacement path no longer calls `session.deleteBlock()` directly.

When an installed `yjs` package is available, the reproducer also builds a real Yjs document and applies an offline nested edit after deleting its top-level `Y.Map` key. In the isolated audit environment, `node_modules` could not be installed because of the internal npm mirror, so this optional runtime check recorded `available: false`. The dependency-free source-path, state-transition, and ordering checks passed.

## Correction

### 1. Common collaborative destructive transition

`public/app.js` adds `withCollaborativeDestructiveTransition()`:

```js
async function withCollaborativeDestructiveTransition(pageId, kind, action) {
  return withPagePersistenceTransition(pageId, kind, async () => {
    await flushPendingPageEdits({
      allowLocked: true,
      collaborationCompact: false
    });
    assertNoPendingLocalCollaborationRecovery(pageId);

    const session = state.selectedPage?.id === pageId
      ? state.collaborationSession
      : null;
    if (!session?.isReady) throw new Error(t("sharing.syncRequired"));

    const result = await action(session);
    await session.flushMaterialization({ compact: false });
    return result;
  });
}
```

The critical order is:

```text
peer flush → recovery inspection → deletion → acknowledgement/materialization → lease release
```

### 2. Collaborative block deletion moved behind the common fence

The collaboration branch of `deleteBlockWithVersionCheck()` now uses the shared transition rather than deleting directly:

```js
return withCollaborativeDestructiveTransition(
  pageId,
  "block-delete",
  async (session) => ({
    deletedIds: session.deleteBlock(blockId, {
      cascade: options.includeDescendants !== false
    })
  })
);
```

This covers context-menu deletion, empty-block deletion, keyboard deletion, and every collaborative path using the common helper.

### 3. Attachment empty-block replacement bypass removed

The attachment-upload collaboration branch no longer calls `session.deleteBlock()` directly. It uses:

```js
await deleteBlockWithVersionCheck(blockId, {
  includeDescendants: false
});
```

If upload has already completed but replacement is blocked because recovery exists, the original source block remains. The uploaded attachment remains as a canonical SQL attachment and can later be adopted through collaboration bootstrap or reconciliation, so the failure does not delete the original edit.

### 4. Regression tests and integrated verification

Added:

- `tests/collaboration-destructive-delete.node.test.mjs`
- `scripts/reproduce-collaboration-block-delete-recovery-loss.mjs`

Updated:

- `public/app.js`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- Documentation index

## Verification results

Dependency-free final checks:

```text
node --experimental-strip-types --test tests/*.node.test.mjs
39 tests passed, 0 failed
```

```text
node scripts/verify-data-loss-guards.mjs
OK
```

```text
node --experimental-strip-types scripts/verify-collaboration.mjs
OK
```

```text
node scripts/reproduce-collaboration-block-delete-recovery-loss.mjs
vulnerable loss window reproduced; fixed recovery fence verified
```

New regression coverage verifies:

- Recovery inspection runs before the destructive action.
- The transition lease remains held until materialization completes after deletion.
- Collaborative deletion uses the common fence.
- Attachment replacement does not call `session.deleteBlock()` directly.
- The vulnerable and corrected state models produce opposite block/recovery preservation outcomes.

Temporary audit output is intentionally excluded from the reorganized project.

## Existing defenses rechecked during the deep review

The audit also rechecked:

- MariaDB strict transactional SQL mode and ambiguous commit handling
- Page/block version snapshots and CAS deletion
- Server-authoritative durable Yjs log and materialization update-ID fence
- Cross-instance collaboration compaction freshness
- Browser durable-before-visible recovery writes
- Fail-closed local recovery checks before page archive, permanent deletion, and sharing disable
- Attachment hard-link claim, `fsync`, and post-commit deletion verification
- Full-backup ZIP CRC32/SHA-256 streaming revalidation
- Restore journal, attachment generation markers, and page-share restoration
- Page-scoped composite foreign key for block parents
- Conservative preservation of malformed or empty `localStorage` records

No separate new permanent-loss path was reproduced in those areas against the reviewed working tree.

## Residual risk and operational guidance

The correction protects tabs on the **same origin that share `localStorage` and Web Locks**. The current tab and server cannot observe edits still isolated on a completely offline device or different browser at deletion time. A collaborative product that allows both hard deletion and offline editing needs one of the following to fully address that class of conflict:

- Server-side block version history or trash
- Soft-delete tombstones retained for a recovery window, with a restore UI
- A policy that promotes late edits to a deleted block into a separate conflict copy

The correction closes the silent loss of observable same-browser recovery. A product-level recovery guarantee for multi-device offline conflicts should still be implemented separately.

## Verification-environment limitations

`npm ci --ignore-scripts --no-audit --no-fund` could not complete because the environment's internal npm mirror returned `404` for `zod-3.25.76.tgz`. The following were not run there:

- Full Vitest suite
- Formal `tsc` build/type check
- Live MariaDB integration tests
- Runtime CRDT reproduction using installed `yjs@13.6.31`
- Real browser multi-tab end-to-end tests

Before deployment, run in a normal development environment:

```bash
npm ci
npm run check
npm run reproduce:collaboration-block-delete-loss
```

The real-browser E2E scenario should verify:

1. Disconnect tab B's WebSocket and edit a block to create recovery.
2. Attempt to delete the same block from tab A.
3. Confirm deletion is blocked with a recovery-pending message.
4. Reconnect tab B and complete acknowledgement/materialization.
5. Retry from tab A and confirm deletion succeeds.
6. Repeat the same sequence for attachment replacement of an empty block.

## `.git` preservation

The original correction deliverable was assembled by extracting the uploaded ZIP into a new directory and overlaying only modified **non-`.git` files**. The `.git` directory was not deleted, initialized, or recreated, and the file inventory and SHA-256 values inside the final ZIP were compared byte-for-byte with the original archive.

## References

- Yjs repository and Shared Types documentation: automatic CRDT update merging and shared `Map`/nested-type behavior
- MDN IndexedDB documentation: transaction completion/abort and browser durable-storage limitations
- OWASP Code Review Guide: race-condition and transactional-integrity/rollback review guidance
