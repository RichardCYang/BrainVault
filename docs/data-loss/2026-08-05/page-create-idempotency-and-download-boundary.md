# Page-creation idempotency and authenticated download boundary review

Date: 2026-08-05

## Intended behavior

BrainVault already treats edit mutations, destructive transitions, backups, collaboration state, and account settings as durable operations whose result must remain bound to the initiating account and latest user intent. Page creation and attachment download must follow the same rules:

- an unknown network outcome must not turn one create intent into two durable pages;
- a rapid second click must not start a parallel creation;
- a completion from an earlier authentication generation must not alter the current workspace;
- a private attachment requested by an earlier account must not download after logout or account replacement;
- a stale `401` response must not reset a newer authenticated session.

## Reproduced defects

### Duplicate page after an ambiguous `POST`

The browser previously sent `POST /api/pages` without a mutation key. When the database transaction committed but the response was lost, retrying the same intent created another independent page. Rapid clicks could also start two requests before either completed.

### Authentication-boundary completion leak

Page creation and attachment download did not retain the initiating account ID and authentication generation. A slow completion from account A could therefore open or list account A's page after account B became active, initiate an account A attachment download, or let a stale `401` reset account B's session.

## Fix

### Durable server receipt

Migration `036_page_create_mutation_receipts.sql` adds an owner-scoped receipt keyed by `(owner_id, mutation_id)`. `POST /api/pages` now:

1. validates and hashes the creation body without the mutation ID;
2. reserves the receipt in the same SQL transaction before inserting the page;
3. creates the page, initial block, tags, and version-history record only for the winning reservation;
4. returns the original page for an exact replay;
5. rejects a key reused with different content;
6. rejects a replay whose original page was permanently deleted instead of creating a replacement.

The receipt intentionally has no foreign key from `page_id` to `pages`, so permanent deletion leaves a tombstone that prevents a delayed retry from recreating deleted content.

### Browser serialization and retry

The three page-creation controls share one busy state. The client gives each create intent a mutation ID, retries one ambiguous failure with that same ID, and retains the task until the created page has been re-listed and opened. This also covers the case where `POST` succeeds but the following page-list refresh or navigation fails: the next same-session attempt replays the original receipt instead of creating a second page. Authentication reset clears the retry map in line with the existing rule that retry queues cannot cross account boundaries.

### Authentication generation scope

Every API request captures the current authentication generation and account key. A `401` resets authentication only when that scope is still current. A successful password change explicitly advances the generation because the server rotates the session cookie even though the account key remains the same. Page creation, page-list refresh, navigation, raw attachment response handling, blob conversion, and the final download click all recheck the same scope before applying an effect.

## Reproduction and regression coverage

```bash
npm run reproduce:page-create-auth-boundary
node --experimental-strip-types --test tests/page-create-auth-boundary.node.test.mjs
npm run test:durability
npm run verify:data-loss
```

The deterministic reproduction proves the vulnerable duplicate request, post-success refresh-failure duplicate, rapid-click race, stale page navigation, stale private download, cross-account stale-401 logout, and same-account credential-rotation stale-401 behavior, then verifies each fixed model produces no such effect.
