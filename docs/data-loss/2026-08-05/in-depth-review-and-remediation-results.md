# BrainVault In-Depth Review and Remediation Results

**Review date:** 2026-08-05

## Conclusion

The development direction of the attached project is understood to be **binding asynchronous results to the account, page, and latest user intent that existed when the operation began, while preventing stale work from changing current state across authentication and data-preservation boundaries**. This principle was already broadly reflected in the existing draft preservation, Yjs collaboration, profile and avatar, page cover, search, and version-history code.

After reviewing the complete flow under reordered delays and lost responses, this pass reproduced and fixed two additional defects beyond the previously corrected authentication, backup, and edit-lock boundary issues and the creation/reset idempotency improvements: a high-risk defect in which deleting an empty block with children could partially commit the document hierarchy because the operation was split across two independent requests, and a defect in which the completion of an ordinary block deletion could not be confirmed when only the response was lost after commit.

1. **Authentication-boundary leakage of account security state:** Login history, passkey names, MFA status, and the TOTP setup secret from a previous account could remain visible in the next account or overwrite it through a late response.
2. **Share list bound to the wrong page:** A slow share-list response for page A could appear in the page B dialog and produce a removal request for the wrong page/user combination.
3. **Latest navigation intent reversal:** When the response for the first, slower document click arrived after a later click, it could revert the final screen to the earlier document.
4. **Race among boot session restoration, manual login, and MFA completion:** Cookie-session restoration during boot could supersede a newer login flow and leave the old user active, while duplicate login/MFA completions could leave the browser session and UI inconsistent.
5. **Account-boundary contamination in backup import/export:** After switching accounts, a backup from the previous account could be downloaded, or a previous import response and page list could overwrite the current account state.
6. **Stale account operation releasing a newer lock:** An old `finally` block could reduce the edit-lock depth for the new account, or a stale transition-lease reference could make the new account appear permanently locked.
7. **Duplicate page creation after response loss:** If `POST /api/pages` committed but only its response was lost, retrying the same user intent could permanently create a second page.
8. **Rapid duplicate clicks and stale creation completion:** Creation buttons did not share a common busy state, allowing parallel requests, and a creation response from the previous account could modify the current list or screen after an account switch.
9. **Authentication-boundary leakage through attachment downloads and late 401 responses:** A private attachment initiated under the previous account could be downloaded automatically under the new account, or a late `401` from an earlier request could reset a newly established login session.
10. **Retry-driven data loss during version-history reset:** If the first reset transaction committed but only its response was lost, new history could be created before the user retried, and the second `DELETE` could remove that new history as well. Progress state and a stale `finally` could also control the wrong dialog instance after close and reopen.
11. **Premature disposal of a receipt after post-success synchronization failure:** If the reset API succeeded but reloading the history list failed, the browser immediately discarded the operation and mutation ID. If new edit history was created before another reset attempt, a second destructive request with a new mutation ID could remove that new history.
12. **Duplicate ordinary block and attachment creation after response loss:** If a block-creation transaction committed but only the HTTP response was lost, the retry generated a new block ID. For attachments, both the block and the physical file were moved and retained again, reproducing two ordinary blocks or two attachment blocks and two files from one user intent.
13. **Partial commit when deleting an empty block while preserving children:** Child promotion and sibling reordering were committed through a separate API before the empty parent was deleted. If only the following DELETE failed, the parent remained, its children had already moved upward, and sibling `sort_order` values could be duplicated, corrupting the hierarchy.
14. **Sequential child-process bottleneck in the collaboration verifier:** The collaboration verifier checked hundreds of files serially in separate Node processes, which could produce no new output for a long period and exceed job limits in constrained CI environments. It was changed to use up to eight bounded workers, a 30-second per-file limit, and explicit failed-file reporting.
15. **Inability to confirm ordinary block deletion after response loss:** If the deletion transaction committed but only the `204` response was lost, the browser remained in a failure state, while retrying the same request returned `404` because the block was already gone. Local draft cleanup did not proceed, and there was no basis for rerunning attachment-file cleanup if the process stopped after the SQL commit.

## Additional Remediation Details

### Authentication flow

- Boot session restoration is bound to an authentication-operation generation, and every asynchronous stage verifies that it is still current.
- If boot restoration records intermediate state and is then superseded, it rolls back only the user state it wrote and does not disturb a newer completed login.
- Login, registration, and MFA verification are serialized so they cannot be submitted more than once in the same tab.
- Login-mode switching, hash-route switching, MFA-method switching, and in-page cancellation are blocked while an authentication request is in flight, reducing the chance that response order conflicts with the browser-managed session cookie.
- Initial workspace loading after successful login is bound to a separate account generation. Page lists that arrive after logout, a `401`, or an account change are ignored.
- The interactive workspace is not exposed until the initial page-list load completes or fails safely. If only page loading fails, the valid login session is retained and an error state is displayed.

### Backup transfer

- Export and import operations are bound to the initiating account ID and request generation.
- Normal closing of the settings dialog is blocked during transfer, while authentication reset force-closes it and invalidates the operation generation.
- Export creates a download link only after validating the full response length and rechecking the account.
- Import verifies that the server response user ID matches the initiating account, receives the page list into a local value, and applies it atomically only after confirming the current account.
- The previous use of `loadPages()`, which changed global state before performing only a final scope check, was removed.

### Edit locks and transition leases

- The authentication-boundary generation is stored when an edit lock is acquired.
- Authentication reset increments the lock generation, preventing a `finally` block from an older generation from releasing the new account's lock.
- Any active transition lease owned by the current tab is explicitly released and its reference cleared during authentication reset.

### Page-creation idempotency and UI serialization

- A `page_create_mutations` receipt table was added with `(owner_id, mutation_id)` as the primary key.
- The page, initial block, tags, creation version history, and receipt are handled in one SQL transaction.
- Replaying the same request body with the same mutation ID returns the original page; reuse with a different body is rejected with `409 MUTATION_ID_REUSED`.
- A late retry after the original page has been permanently deleted does not create a new page and is rejected with `409 PAGE_CREATE_REPLAY_UNAVAILABLE`.
- Collection, home, and sidebar creation buttons share one busy state, and ambiguous failures are retried automatically once with the same mutation ID.
- Even if list refresh or navigation fails after successful server-side creation, the operation receipt is retained until the full UI flow completes so the next attempt cannot create a duplicate page.

### Ordinary block and attachment creation idempotency

- A `block_create_mutations` receipt table and upgrade migration `038_block_create_mutation_receipts.sql` were added.
- `(actor_id, mutation_id)` is the primary key, and the receipt stores the page, created block ID, and normalized request SHA-256.
- For both ordinary blocks and attachments, receipt reservation occurs in the same SQL transaction before block insertion, page content-version increment, and version-history recording.
- An attachment request hash combines the normalized filename, inspected MIME type, byte length, and a streaming SHA-256 of the actual uploaded bytes. The file is moved to permanent storage only after receipt reservation succeeds.
- Replaying the same request returns the original block without creating another block, history entry, or file. Reusing the key with different content fails with `409 MUTATION_ID_REUSED`; replaying after the original block has been deleted fails closed with `409 BLOCK_CREATE_REPLAY_UNAVAILABLE`.
- Replay resolution occurs before current shared/archived-state write restrictions, allowing an already completed result to be confirmed even if the page state changed after the first write. Existing restrictions still apply to new writes.
- The browser retries an ambiguous failure once with the same key and discards pending work if the authentication generation changes. Two legitimate creations started concurrently are not merged by the `inFlight` boundary.

### Ordinary block-deletion idempotency after response loss

- A `block_delete_mutations` receipt table and upgrade migration `039_block_delete_mutation_receipts.sql` were added.
- `(actor_id, mutation_id)` is the primary key. The receipt stores the deletion target, normalized request SHA-256, committed page content version, and deleted attachment block IDs. Because deletion proof must remain after the target row is gone, `block_id` intentionally has no foreign key.
- Before looking up the target block, the server locks and checks the actor-scoped receipt. Replaying the same block and request body confirms the existing result with `204` without deleting again. Reuse for a different request returns `409 MUTATION_ID_REUSED`, and malformed or incomplete receipts fail closed without repeating destructive work.
- The first receipt is recorded in the same SQL transaction as the block-hierarchy mutation, deletion, page content-version increment, and version-history entry.
- Attachment-file cleanup runs after transaction commit but can be rerun during replay using the list stored in the receipt, recovering from a process stop between SQL commit and file deletion.
- The browser freezes the original version snapshot and payload and retries an ambiguous failure once with the same mutation ID. After a second ambiguous failure, it retains the same operation; the ID is not reused if the authentication generation, account, page, block, or preserve-children mode changes.
- Local block drafts are removed only after the server confirms either first execution or an exact receipt replay.

### Atomic deletion of an empty block while preserving children

- The browser-side preliminary block-reorder request was removed, and the complete intent is expressed through a single `DELETE /api/blocks/:blockId` request.
- A `preserveChildren` request includes exact edit-version snapshots for the target and all descendants, together with the current page content version.
- After locking the page row and complete block hierarchy, the server performs child promotion, sibling resequencing, target deletion, content-version increment, and version-history recording in one SQL transaction.
- Failure at any stage rolls back every hierarchy change, and browser drafts for preserved children are not removed.
- In collaborative editing, child promotion and target deletion are grouped into one Yjs mutation.
- The OpenAPI specification and feature documentation now describe preserve-children deletion behavior and its concurrency preconditions.

### Collaboration-verification pipeline reproducibility

- Separate Node syntax checks for 275 JavaScript/TypeScript files were parallelized with a limit of eight workers.
- Each file check has a 30-second ceiling and reports the file path and standard error on failure.
- The same verification, which took approximately 34 seconds before the change, completed normally in approximately 19 seconds in the measured post-change run without reducing scope.

### Page-version-history reset idempotency

- A `page_version_reset_mutations` receipt table and upgrade migration `037_page_version_reset_mutation_receipts.sql` were added.
- The reset API requires a `mutationId` and follows the existing global lock order of owner row then page row before reserving an `(owner_id, mutation_id)` receipt ahead of destructive deletion.
- Replaying the same page and request hash returns the original `revision` and `deletedCount` without invoking the reset function again.
- Reusing the same ID for another page is rejected with `409 MUTATION_ID_REUSED`, and an abnormal incomplete receipt fails closed without performing a second deletion.
- For ambiguous outcomes such as network errors, successful-response parse failures, or 5xx responses, the browser retries automatically once with the same mutation ID and retains the same operation for manual retry after a second ambiguous failure.
- Dialog close/reopen and authentication-generation transitions, including password changes for the same account, are bound to the operation scope.
- The operation is not discarded merely because the API succeeded. It is removed only after the history list has actually resynchronized for the same authentication scope and page. A manual retry after list-refresh failure reuses the existing mutation ID, causing the server to replay the first result and preserve any new history created in the meantime.

### Completion effects after the authentication generation changes

- API requests capture the authentication generation and account key at start, and a late `401` resets authentication only when it belongs to the same session.
- When a password change replaces the server cookie, the authentication generation increases even though the account ID is unchanged, preventing a response initiated with older credentials from resetting the new session.
- Page-creation responses, full-list refreshes, and page/collection navigation verify after every stage that the initiating account is still current.
- Attachment responses recheck scope after response receipt and again after Blob conversion, and no download click is created before the final check.
- Authentication reset clears both creation busy state and retry maps for the same session.

## Reproduction and Testing

Additional reproduction commands:

```bash
npm run reproduce:auth-data-lock-boundary
npm run reproduce:page-create-auth-boundary
npm run reproduce:page-version-reset-retry
npm run reproduce:block-create-response-loss
npm run reproduce:block-delete-response-loss
npm run reproduce:block-preserve-children-delete
```

Additional regression coverage:

- `tests/auth-data-lock-boundary.node.test.mjs`
- Four boot-restoration ownership and rollback cases in `tests/auth-session-bootstrap.node.test.mjs`
- Five receipt, migration, UI authentication-scope, and independent reproduction cases in `tests/page-create-auth-boundary.node.test.mjs`
- Six receipt-resolution, SQL-ordering, migration, UI retry/authentication-scope, post-success list-synchronization failure, and independent reproduction cases in `tests/page-version-reset-idempotency.node.test.mjs`
- Initial execution, lost-response replay, ownership, and required mutation-ID integration cases in `tests/page-version-history-reset.routes.test.ts`
- Five receipt-resolution, SQL/file-move ordering, browser retry/authentication-scope/concurrent-intent separation, migration, and independent reproduction cases in `tests/block-create-idempotency.node.test.mjs`
- Six exact receipt replay, conflict/incomplete-receipt resolution, attachment-cleanup scope, server SQL ordering, browser retry/authentication scope, migration, and independent reproduction cases in `tests/block-delete-idempotency.node.test.mjs`
- Four partial-commit model, single-request UI, page-lock SQL transaction, and single Yjs mutation cases in `tests/block-preserve-children-delete.node.test.mjs`
- Independent reproduction of the original failure state, rollback after a post-fix failure, and the post-fix success state in `scripts/reproduce-block-preserve-children-delete-race.mjs`
- Data-loss verification and static checks updated for backup, page/block/attachment creation and deletion, and version-history reset changes

## Final Verification Results

- Dependency-free Node durability tests: **175/175 passed**
- Additional preserve-children deletion atomicity regression tests from this pass: **4/4 passed**
- Additional version-history reset regression tests from this pass: **6/6 passed**
- Additional block/attachment creation idempotency regression tests from this pass: **5/5 passed**
- Additional block-deletion response-loss idempotency regression tests from this pass: **6/6 passed**
- Lockfile registry check: **346 URLs passed**
- Data-loss prevention verification: passed
- Collaboration, protocol, and source verification: passed; **278 files syntax-checked** and completed normally in approximately **19 seconds** after bounded parallelization
- Security-hardening verification: passed; dependency-free security regressions **11/11 passed**
- Syntax checks for changed JavaScript and reproduction scripts: passed

## Execution Environment Limitations

The project requires Node.js `^22.23.2 || ^24.18.1 || >=26.5.1` and npm `engine-strict`, but the review environment provided Node.js 22.16.0. `npm ci --ignore-scripts --engine-strict=false` also stopped with `404` because the sandbox package mirror did not contain the locked `zod@3.25.76` artifact. Because dependencies could not be installed, a global `tsc` check could not complete due to missing `node` and `vitest/globals` type definitions.

Accordingly, the full TypeScript build and dependency-based full Vitest suite are not reported as completed. Instead, JavaScript/TypeScript syntax checks, 175 dependency-free regressions, and the data-loss, collaboration, and security verifiers were run. `node_modules` is not included in the deliverable.

## Complete Reproduction and Verification Commands

```bash
npm run reproduce:account-security-auth-boundary
npm run reproduce:share-dialog-request-race
npm run reproduce:workspace-navigation-race
npm run reproduce:auth-data-lock-boundary
npm run reproduce:page-create-auth-boundary
npm run reproduce:page-version-reset-retry
npm run reproduce:block-create-response-loss
npm run reproduce:block-delete-response-loss
npm run reproduce:block-preserve-children-delete
npm run test:durability
npm run lockfile:check
npm run verify:data-loss
npm run verify:collaboration
npm run verify:security
```

## `.git` Preservation

The `.git` directory was not deleted, reinitialized, or cleaned. Before delivery, the final archive is compared with the uploaded source ZIP to confirm identical `.git` relative paths, file types, sizes, and SHA-256 hashes.

Detailed technical documents:

- `docs/data-loss/2026-08-05/account-security-and-ui-request-scope.md`
- `docs/data-loss/2026-08-05/auth-data-and-lock-boundary-review.md`
- `docs/data-loss/2026-08-05/page-create-idempotency-and-download-boundary.md`
- `docs/data-loss/2026-08-05/page-version-reset-idempotency.md`
- `docs/data-loss/2026-08-05/block-create-response-loss-idempotency.md`
- `docs/data-loss/2026-08-05/block-delete-response-loss-idempotency.md`
- `docs/data-loss/2026-08-05/block-preserve-children-delete-atomicity.md`
