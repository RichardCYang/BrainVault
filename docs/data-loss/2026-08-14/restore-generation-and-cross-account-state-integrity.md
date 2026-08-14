# Restore Generation and Cross-Account State Integrity Review

Date: 2026-08-14
Baseline HEAD: `54a6f2252e9d08171da7f6d90771d6bf4f162c64`

## Scope

This review focused on durable user data that can be destroyed, duplicated, silently replaced, or made unreachable by workspace restore and by delayed retries that cross a restore boundary. The audit covered the MariaDB foreign-key graph around `pages`, workspace backup/restore, cross-account navigation preferences, mutation idempotency receipts, page-version history, block version fencing, page sharing, Yjs collaboration materialization, attachment/custom-icon generation swaps, and existing durability reproductions.

## Confirmed finding 1: owner restore erased collaborators' navigation preferences

`user_navigation_collapsed_pages.page_id` and `user_navigation_page_order.page_id` both reference `pages(id)` with `ON DELETE CASCADE`. Workspace restore replaces the owner's page generation with `DELETE FROM pages WHERE owner_id = ?` followed by reinsertion. The backup manifest carries only the restoring owner's navigation state. As a result, a successful owner restore deleted another account's collapsed-page and custom-order rows for shared pages and did not recreate them even when that collaborator's `EDIT` grant survived the restore.

### Fix

Before destructive page replacement, restore now:

1. Resolves and locks the final collaborator identities through the existing sharing plan.
2. Captures collapsed/order rows for those final collaborator IDs on the owner's current pages with `FOR UPDATE`.
3. Filters captured rows to page/user share pairs that will exist after restore.
4. Recreates those rows after pages and shares are restored in the same database transaction.
5. Preserves `created_at` for collapsed rows and `updated_at` for order rows.

The capture includes dormant preferences left from an older grant when the backup restores that collaborator's grant. Preferences belonging to a grant that is removed by the restore are intentionally not resurrected.

Reproduction: `scripts/reproduce-collaborator-navigation-restore-loss.mjs`
Regression: `tests/collaborator-navigation-restore-integrity.node.test.mjs`

## Confirmed finding 2: restore erased idempotency tombstones and allowed stale retries to cross generations

Page replacement also cascades page-tied mutation receipt rows. Two receipt classes are unsafe to lose across a restore when the page identity survives:

- `page_version_reset_mutations`: an exact reset that committed but lost its HTTP response could be retried after restore. Without the receipt, it was treated as a new reset and could delete version history just restored from the backup.
- `block_create_mutations`: an exact create that committed but lost its response could be retried after restore. Without the receipt, it could create a duplicate block, or recreate content that the backup intentionally omitted.

`block_order_mutations` is also preserved as a no-side-effect replay tombstone so a delayed exact reorder does not cross the restore generation as new work.

### Fix

Before page replacement, restore captures the reset/order/create receipt rows for current owned pages with `FOR UPDATE`, filters them to page IDs present in the restore manifest, and reinserts them after the page rows are recreated but before commit. The receipt timestamps and result fields are retained.

### Important exception: block-delete receipts are deliberately not preserved

`block_delete_mutations` is page-tied and is also cascaded, but preserving it verbatim across restore would be dangerous. A replayed block-delete receipt carries `attachment_ids`; the route performs attachment-file cleanup after receipt replay. If a backup resurrected one of those attachment IDs, replaying the old cleanup scope could remove the newly restored file while leaving the restored block row.

Therefore restore intentionally leaves block-delete receipts behind. A stale block-delete request is instead stopped by the existing restore generation fence: restored blocks are assigned the large restore-only `edit_version`, while delete requests require an exact `expectedVersions` snapshot before any delete executes. The reproduction explicitly verifies both the unsafe "preserve delete receipt" model and the safe version-conflict model.

Reproduction: `scripts/reproduce-restore-mutation-receipt-loss.mjs`
Regression: `tests/restore-mutation-receipt-integrity.node.test.mjs`

## Other high-risk paths reviewed

No additional correction was required for the following paths in this review:

- Page sharing: current backup format carries stable collaborator identity; legacy grants are preserved only when they can be verified against the current exact grant.
- Page version history and owner's navigation state: current backup version carries them and restores them transactionally.
- Page/block update retries: restore assigns a new high edit/content version, so stale versioned mutations fail closed rather than overwriting restored content.
- Page creation receipts: `page_create_mutations` intentionally has no page foreign key, so page replacement does not erase the tombstone.
- Yjs collaboration: restore disconnects live rooms while page rows are locked; durable updates are materialized into authoritative page/block rows before destructive replacement, and collaboration lineage is rebuilt for the restored generation.
- Attachments/custom icons: restore uses staged generations, durable restore journals/markers, filesystem synchronization, and rollback/recovery paths rather than deleting the previous generation before commit outcome is known.
- Attachment delete/create ambiguity: existing commit-outcome and cleanup fencing retains files when the database outcome cannot be proven.

## Verification performed

- Both standalone reproductions prove the vulnerable baseline conditions from `HEAD` and the corrected behavior in the modified source.
- Focused durability regression set: 23 tests passed, 0 failed.
- Full dependency-free Node durability suite after the fix: 295 tests total, 290 passed, 5 failed. The same five failures were present before these changes: four are source `.js`/TypeScript module-resolution failures under the sandbox Node runtime, and one is a pre-existing stale textual security assertion in `security-followup-remediation.node.test.mjs`.
- `node --experimental-strip-types --check src/lib/data-transfer.ts` passes.
- New reproduction/test/guard scripts pass `node --check`.
- `scripts/lockfile-registry.mjs` passes.
- The central `verify-data-loss-guards.mjs` executes the newly added restore guards/reproductions successfully and then reaches a pre-existing `ERR_MODULE_NOT_FOUND` at the structured-metadata reproduction under the sandbox runtime.

## Environment limitation

The project declares Node `^22.23.2 || ^24.18.1 || >=26.5.1`; the provided sandbox runtime is Node `22.16.0`. The uploaded `node_modules` tree does not contain executable package contents, and the sandbox cannot install the project dependencies from the network. Consequently the TypeScript build, Vitest unit suite, and a live MariaDB integration restore were not runnable here. The corrections were validated with source-level invariants, deterministic baseline-vs-fixed reproductions, syntax checks, and the dependency-free durability suite described above.
