# Legacy recovery cleanup audit (2026-09-11)

Confirmed defect: putLegacyRecord and removeLegacyRecord did not reconcile queued removal snapshots after successful transactions or rejected legacy comparisons. If cleanup and its verification read then failed, the in-memory recovery store restored obsolete text, masking a newer durable draft or resurrecting acknowledged data.

Reproduction:
1. Migrate a legacy localStorage draft containing "old" into IndexedDB.
2. Deliver a legacy storage event replacing it with "new" or acknowledging its deletion. Alternatively, let a peer replace/delete the durable draft before a stale legacy event.
3. Immediately queue removeItem or clear before the legacy operation settles.
4. Allow the legacy transaction to complete, then inject cleanup transaction creation failure and readback failure.
5. Previously the mirror returned "old"; it now matches the durable result. Newer uncommitted local text/binary drafts remain protected.

Implementation: reuse the existing sequence- and write-token-aware reconcileRemovalSnapshot helper in both legacy paths, only after transaction completion. Both accepted and rejected comparisons update the fallback. No authorization, SQL, rendering, or request input boundary is changed; the patch introduces no HTML sink or resource-access endpoint.

Validation: 12 reproduction cases fail against original source and pass after remediation. Eight additional newer-text/binary-write cases pass. All 115 IndexedDB recovery tests and 30 adjacent persistence, lossless-payload, and note-auth-boundary tests pass. Tests use the project's fake IndexedDB fault-injection harness; they are not live-browser tests. Build attempted but blocked by missing tsc; three adjacent Vitest files could not load because vitest is not installed. Live-browser and MariaDB integration were not run. No claim of a complete vulnerability-free application is made.

Architecture reviewed: recent Git history through 4512466, browser draft and collaboration recovery stores, IndexedDB mutation queue, MariaDB client, page route locking, and deletion mutation receipts. Original working-tree differences were retained. Git was inspected only through subprocess Git CLI with optional locks disabled. The final archive is copied from the input and updated only with the three reviewed files; original .git ZIP members are retained.

Technical reference: https://www.w3.org/TR/IndexedDB/#transaction-lifecycle (transaction completion/abort semantics).

Applied source patch:

```diff
--- a/public/indexeddb-recovery-storage.js
+++ b/public/indexeddb-recovery-storage.js
@@ -721,6 +721,12 @@
         };
       });
       await Promise.all([comparison, complete]);
+      // Rebase queued cleanup only after the legacy transaction completes.
+      // Rejected legacy comparisons also establish the durable fallback; the
+      // shared helper protects newer local edits and uncommitted writes.
+      reconcileRemovalSnapshot(
+        key, visibleMutationSequence, matched ? true : currentExists, matched ? value : currentValue
+      );
 
       const mirrorStillMatchesRequest = !uncommittedWrites.has(key)
         && (keyMutationSequences.get(key) ?? 0) === visibleMutationSequence;
@@ -802,6 +808,12 @@
         };
       });
       await Promise.all([comparison, complete]);
+      // Rebase queued cleanup only after the legacy transaction completes.
+      // Rejected legacy comparisons also establish the durable fallback; the
+      // shared helper protects newer local edits and uncommitted writes.
+      reconcileRemovalSnapshot(
+        key, visibleMutationSequence, matched ? false : currentExists, currentValue
+      );
 
       const mirrorStillMatchesRequest = !uncommittedWrites.has(key)
         && (keyMutationSequences.get(key) ?? 0) === visibleMutationSequence;

```
