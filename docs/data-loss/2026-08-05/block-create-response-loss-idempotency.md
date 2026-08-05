# Block and attachment creation response-loss idempotency review

Date: 2026-08-05

## Intended behavior

BrainVault's persistence design already treats an acknowledged edit, page creation, reorder, and destructive reset as one durable user intent even when the client cannot determine whether the server committed. Ordinary block creation and attachment upload must preserve the same invariant:

- one user create intent produces at most one durable block;
- an attachment retry cannot create a second block or a second stored file;
- the same mutation key cannot be reused with different content;
- a replay remains readable after the page becomes archived or shared, because it confirms an earlier completed write rather than performing a new write;
- a retry task cannot cross an authentication-session boundary;
- two simultaneous, legitimate create intents must not be collapsed into one.

## Reproduced defect

`POST /api/pages/:pageId/blocks` and `POST /api/pages/:pageId/attachments` previously had no creation receipt. Each request generated a new block ID. If the SQL transaction committed but the HTTP response was lost, retrying the same browser intent created a second block. Attachment retries additionally moved and retained a second physical file.

The deterministic reproduction reports the following vulnerable outcome after one lost response and one retry:

- ordinary blocks: `2`;
- attachment blocks: `2`;
- stored attachment files: `2`.

## Fix

### Transactional creation receipts

Migration `038_block_create_mutation_receipts.sql` adds `block_create_mutations`, keyed by `(actor_id, mutation_id)`. The receipt stores the page, generated block ID, and canonical SHA-256 request hash. The fresh-database schema in `001_init.sql` includes the same table.

Both creation routes now reserve the receipt in the same SQL transaction before inserting a block. An exact replay returns the original/current block and current page content version without repeating block insertion, version-history insertion, content-version advancement, or file movement. Reusing a key with another page or payload returns `409 MUTATION_ID_REUSED`. If the original block was later deleted, the server fails closed with `409 BLOCK_CREATE_REPLAY_UNAVAILABLE` instead of silently creating a replacement.

The replay check intentionally occurs before current shared-page or archived-page mutation gates. This lets a retry confirm an already committed result after page state changes, while every genuinely new write still passes the current mutation gates.

### Attachment identity

The attachment request hash binds:

- page, parent, and requested sort position;
- normalized original filename and inspected MIME type;
- byte length;
- a streaming SHA-256 of the uploaded bytes.

Therefore, a browser file with the same name, size, MIME type, and timestamp but different bytes cannot be mistaken for the original retry. A collision rotates to a fresh mutation ID only for a genuinely new request.

### Browser retry and authentication fencing

The browser assigns a mutation ID to ordinary block and attachment creates, retries an ambiguous result once with the same ID, and retains unresolved tasks only inside the same authenticated session. Logout, account replacement, or authentication-generation rotation clears the pending maps.

An in-flight task is not reused by another simultaneous create call. This preserves two rapid but legitimate create intents while still allowing a later retry of an unresolved intent to reuse its original key.

## Reproduction and regression coverage

```bash
npm run reproduce:block-create-response-loss
node --experimental-strip-types --test tests/block-create-idempotency.node.test.mjs
npm run test:durability
npm run verify:data-loss
npm run verify:collaboration
npm run verify:security
```

The fixed reproduction retains exactly one ordinary block, one attachment block, and one stored file; both replays return the original block IDs; and changed-payload key reuse is rejected.

## Deployment note

Existing installations must apply migration `038_block_create_mutation_receipts.sql` through the normal migration command before serving the updated application. API clients that want response-loss-safe creation should send `mutationId`; the updated BrainVault browser does so automatically.
