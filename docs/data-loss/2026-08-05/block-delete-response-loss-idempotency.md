# Block-deletion response-loss idempotency review

Review date: 2026-08-05

## Risk

The direct block-deletion route previously committed the SQL transaction and returned `204` without a stable mutation receipt. If the response was lost after commit, the server had deleted the block but the browser could not distinguish that state from a failed request. The browser retained local drafts and UI state. A retry queried the now-missing block and returned `404`, so the original deletion could not be acknowledged and post-commit attachment cleanup could not be deliberately replayed.

This is an especially important boundary for `DELETE`: clients may retry an idempotent request when the connection fails before a response is read. The observable final state therefore needs to be confirmable without repeating the destructive transition.

## Reproduction

Run:

```bash
npm run reproduce:block-delete-response-loss
```

The model reports:

- vulnerable behavior: the block is deleted, but the retry is not acknowledged;
- corrected behavior: the block remains deleted, the exact retry is acknowledged, and attachment cleanup can safely run again.

## Correction

### Server receipt

Migration `039_block_delete_mutation_receipts.sql` adds `block_delete_mutations` with an actor-scoped primary key `(actor_id, mutation_id)`. Each completed receipt stores:

- page and deleted block identity;
- SHA-256 of the normalized deletion intent;
- the committed page content version;
- the attachment block IDs whose files must be removed.

There is no foreign key from `block_id` to `blocks`, because the receipt must survive deletion of the row it identifies. Actor and page foreign keys retain normal account/page cleanup behavior.

The route locks the actor receipt scope before looking up the target block. An exact existing receipt returns the committed result without attempting the deletion again. A mutation-ID collision returns `409 MUTATION_ID_REUSED`. An incomplete or malformed receipt returns an error and does not repeat the delete. New receipts are inserted in the same transaction as hierarchy changes, the block deletion, page content-version advancement, and page-version history.

### Filesystem healing

Attachment files are removed only after the database transaction commits. The stored attachment list is returned for both first execution and receipt replay, so an exact retry repeats only the idempotent cleanup step. This closes the process-crash boundary between SQL commit and file removal without recreating or deleting additional database rows.

### Browser retry scope

The browser freezes the original version snapshot and payload, assigns one mutation ID, and retries one ambiguous failure with the same request. A second ambiguous failure retains the task for a later manual retry. Definitive failures clear it. Pending tasks are scoped to authentication generation, account, page, block, and preserve/cascade mode and are cleared at authentication boundaries. Local drafts are removed only after the server has acknowledged either the first execution or an exact replay.

## Regression coverage

- `tests/block-delete-idempotency.node.test.mjs`: receipt match/collision/incomplete handling, malformed attachment metadata, SQL ordering, browser retry/authentication scope, schema migration, and independent reproduction.
- `scripts/verify-data-loss-guards.mjs`: baseline/migration schema, receipt lookup before missing-block resolution, atomic receipt insertion, replayable file cleanup, client mutation reuse, and reproduction assertions.
- `scripts/reproduce-block-delete-response-loss.mjs`: vulnerable and corrected response-loss models.

The implementation remains backward compatible because `mutationId` is optional at the API boundary. The bundled browser always supplies it for direct non-collaborative deletion.
