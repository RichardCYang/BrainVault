# BrainVault data-loss deep audit — block-order range integrity

- Audit date: 2026-07-30
- Scope: uploaded BrainVault working tree
- Finding: **High — silent structural ordering loss was possible**
- Remediation status: complete

## Conclusion

`blocks.sort_order` is a signed MariaDB `INT`, whose maximum value is `2,147,483,647`. Before the correction, the following input paths accepted integers without enforcing that upper bound:

1. General block create and update APIs
2. Block reorder API
3. Attachment-block creation form
4. Backup ZIP restore manifest
5. Automatic append using `last_sort_order + 1`

MariaDB documentation states that, when strict SQL mode is disabled, an out-of-range number can be adjusted to the nearest valid boundary and reported as a warning. The Node.js connector exposes `warningStatus` on successful results, but the previous write paths did not treat that warning as an integrity failure. Distinct large order values could therefore both be stored as `INT_MAX`, after which the `id` tie-breaker in `ORDER BY sort_order, id` could replace the user's intended block order.

The block text itself was not deleted, but the ordering of blocks can carry document or list meaning. Permanently changing that order is therefore a form of **structural data loss**.

## Reproduction

Run:

```bash
npm run reproduce:block-order-loss
```

The reproducer models MariaDB's documented boundary adjustment in non-strict mode.

- Requested values: `INT_MAX + 1`, `INT_MAX + 2`
- Stored values: both become `INT_MAX`
- Intended order: `blk_z`, `blk_a`
- Query order: `blk_a`, `blk_z`

After the correction, both requests are rejected before SQL execution. Automatic append after the maximum value also fails closed with `409 BLOCK_ORDER_RANGE_EXHAUSTED` and creates no block.

## Correction

### 1. Single range contract

`src/lib/block-order-integrity.ts` defines the allowed range `0..2,147,483,647` and centralizes safe-integer validation and append-overflow prevention.

### 2. All external input paths fenced

The create, update, reorder, and attachment-upload schemas in `src/routes/block.routes.ts` use the same upper bound.

### 3. Automatic append overflow blocked

Direct `lastBlock.sort_order + 1` arithmetic was removed. If the range is exhausted or the existing value is invalid, the operation fails before any database write and no block is created.

### 4. Backup restore validation

`src/lib/data-transfer.ts` rejects backups containing negative or out-of-range `sort_order` values before starting the restore transaction.

### 5. Database session defense

The MariaDB pool in `src/lib/db.ts` uses `initSql` to enforce `STRICT_TRANS_TABLES` on every connection. Invalid transactional writes therefore cannot be silently converted with only a warning, even when the operator's global SQL mode is permissive.

### 6. Regression tests

- `tests/block-order-integrity.node.test.mjs`
- `scripts/reproduce-block-sort-order-overflow-loss.mjs`
- Integration in `scripts/verify-data-loss-guards.mjs`

## Changed files

- `src/lib/block-order-integrity.ts` (new)
- `src/routes/block.routes.ts`
- `src/lib/data-transfer.ts`
- `src/lib/db.ts`
- `scripts/reproduce-block-sort-order-overflow-loss.mjs` (new)
- `tests/block-order-integrity.node.test.mjs` (new)
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- This audit report

## `.git` preservation verification

The SHA-256 of the path-sorted manifest containing every regular file under `.git` was identical before and after the audit and correction:

```text
0e12a8231ce8b64744181fc58d722c8f0bc4dd23a7dffb884622a6875147212f
```

No file under `.git` was changed or deleted during that work. The SHA-256 of the original uploaded ZIP was `53673e7388fcadaee5bb46fff7b6fa30ba277aa6e8a48f67215eeb768c26d793`.

## Verification scope and limitations

- Static data-flow audit: complete
- Deterministic reproduction of the documented vulnerable behavior: complete
- Post-fix boundary, overflow, and input-surface tests: complete
- Existing dependency-free durability tests and data-loss guards: passed (`23/23`)
- JavaScript/MJS syntax checks: passed (`31/31`)
- TypeScript executable-source syntax checks, excluding declaration files: passed (`101/101`)
- Collaboration-integrity verifier: passed, including wiring and syntax checks for `147` files
- Six reproduction commands: completed
- MariaDB-process integration reproduction: not run because the audit environment did not provide a MariaDB server or client
- Full npm build and Vitest suite: not run because the environment's internal npm mirror did not return the `zod@3.25.76` tarball

The environmental limitations are recorded explicitly. The corrected project includes scripts that can be run unchanged in a development environment with MariaDB and normal npm access.

## Official references

- MariaDB INT: https://mariadb.com/docs/server/reference/data-types/numeric-data-types/int
- MariaDB Numeric Data Type Overview: https://mariadb.com/docs/server/reference/data-types/numeric-data-types/numeric-data-type-overview
- MariaDB Connector/Node.js Promise API (`warningStatus`): https://mariadb.com/docs/connectors/mariadb-connector-nodejs/connector-nodejs-promise-api
- MariaDB Connector/Node.js Connection Options (`initSql`): https://mariadb.com/docs/connectors/mariadb-connector-nodejs/node-js-connection-options
- MariaDB SQL_MODE: https://mariadb.com/docs/server/server-management/variables-and-modes/sql_mode
