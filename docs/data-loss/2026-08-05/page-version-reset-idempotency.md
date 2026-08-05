# Page-version reset idempotency review

Date: 2026-08-05

## Finding

The owner-only page-version reset endpoint deleted all rows from `page_versions` and wrote a new revision-1 baseline, but it did not accept or persist an idempotency key. If the database transaction committed and only the HTTP response was lost, the browser reported failure. A later retry issued a new destructive request. Any version rows created between the first commit and the retry were deleted by that second reset.

The browser also stored reset progress only in the currently open dialog. Closing and reopening the history dialog cleared the local `resetting` flag even while the original request remained in flight, and an older `finally` could update the shared dialog state after the page or authentication generation changed.

A narrower post-response gap remained after the first idempotency fix: the browser retired its pending task as soon as the API returned success, even when the required history-list refresh failed. If a later edit created a new version before the user retried, the discarded task forced a new mutation ID and a second destructive reset, deleting that later history.

## Reproduction

Run:

```bash
npm run reproduce:page-version-reset-retry
```

The independent model performs these steps:

1. Reset a history containing revisions 1–3.
2. Treat the successful response as lost.
3. Record a new version after the first reset.
4. Retry the reset.

The vulnerable model loses the new version. The fixed model replays the first receipt and preserves it.

The reproduction also covers an API-success/list-refresh-failure gap. The vulnerable client discards the original mutation ID, so a manual retry performs a second reset and deletes the intervening edit. The fixed client retains the original task until list synchronization, reuses the same mutation ID, receives the original replay, and preserves the later edit.

## Server correction

Migration `037_page_version_reset_mutation_receipts.sql` creates `page_version_reset_mutations`, keyed by `(owner_id, mutation_id)`. Its result columns are nullable so the transaction can reserve the identity before the destructive statement and fill in the result afterward.

`DELETE /api/pages/:pageId/versions` now requires `mutationId`. It first locks the owner row and then the owned page row, preserving the repository-wide owner-before-page order used by export, restore, and attachment cleanup. It then:

1. Computes a canonical request hash bound to the page ID.
2. Inserts the receipt before deleting any version row.
3. On a duplicate key, locks and assesses the existing receipt.
4. Replays a matching completed result without calling the reset function.
5. Rejects a page/hash collision and refuses to repeat an incomplete receipt.
6. Deletes the old history, writes the revision-1 baseline, and completes the receipt in the same SQL transaction.

A rollback removes both the reservation and destructive changes. A commit makes both the reset and replay result durable together.

## Browser correction

The browser keeps owner/authentication-generation/page-scoped reset tasks in `pendingPageVersionResetTasks`. An ambiguous network, invalid-success-response, or server error is retried once with the same `mutationId`; a second ambiguous failure leaves that task available for a later manual retry. Definitive 4xx failures discard it.

Closing the dialog does not discard the task. Reopening the same page detects an in-flight task and keeps destructive controls disabled. Completion effects are applied only when the initiating authentication scope and page are still current. Logout, authentication reset, and password-driven credential rotation clear all pending reset tasks.

An API success no longer retires the task by itself. The task is removed only after `loadPageVersionHistory()` successfully synchronizes the same page under the same authentication scope. A failed refresh therefore leaves the original mutation ID available for a safe replay instead of turning the next manual attempt into a new destructive operation.

## Regression coverage

- `tests/page-version-reset-idempotency.node.test.mjs`
- `tests/page-version-history-reset.routes.test.ts`
- `scripts/reproduce-page-version-reset-retry-loss.mjs`
- `scripts/verify-data-loss-guards.mjs`

The route test covers first execution, exact replay after a later edit, owner enforcement, and the required mutation ID. The dependency-free test checks receipt assessment, SQL ordering, fresh/upgrade migrations, browser task reuse, authentication fencing, post-success list-synchronization retention, and both response-loss and refresh-gap reproductions.
