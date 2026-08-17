# Page-version reset stale-state fence

## Finding

The owner-only page-version reset was retry-idempotent, but a new mutation had no optimistic-concurrency precondition. If another tab committed an edit after the owner reviewed and confirmed the reset but before the reset transaction acquired the page lock, that edit could append a version-history row and then be erased by the later reset.

## Reproduction

1. Open a page version-history dialog at page edit version 7, content version 11, history revision 3.
2. Confirm the reset, but delay that DELETE before it acquires the page lock.
3. In another authenticated owner session, edit the page or a block so content version becomes 12 and history revision becomes 4.
4. Let the original reset continue. The previous implementation deleted all `page_versions`, including revision 4, because it checked ownership and idempotency but not the state the owner had reviewed.

## Correction

The browser now binds each reset task to `expectedVersion`, `expectedContentVersion`, and `expectedRevision` from the displayed history response. The server includes those values in the mutation request hash and, for a newly reserved mutation, compares them against the locked page and current maximum history revision before calling the destructive reset routine. A mismatch fails with `409 PAGE_VERSION_RESET_CONFLICT` and no history deletion.

Completed mutation-receipt replay intentionally runs before the stale-state comparison. This preserves the existing ambiguous-commit guarantee: retrying the exact same mutation after a committed reset returns its original result even if newer history exists, rather than performing or rejecting a second destructive reset.

## Security and regression invariants

- Ownership remains enforced by `SELECT ... FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE`; collaborators cannot reset owner history.
- The mutation receipt remains owner-scoped and exact-body hashed, preventing mutation-ID reuse with a different snapshot.
- No user-controlled history content is rendered through new HTML sinks; the patch changes only numeric reset preconditions and existing translated status text.
- The client refreshes the authoritative history list after a stale-snapshot conflict so a subsequent confirmation is based on current state.
- `scripts/reproduce-page-version-reset-retry-loss.mjs` now demonstrates both the historical response-loss issue and the stale-view concurrent-edit issue.
