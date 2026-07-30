# Archived-page sharing backup round-trip integrity

## Severity

**High — recovery false success and loss of sharing state after a disaster.**

The exporter could successfully create a ZIP that the importer later rejected. The trigger was an ordinary page that already had an editor grant and was then archived. Archiving stopped collaboration but intentionally retained the `page_shares` row. Export included that row, while import rejected every share targeting an archived page.

A user could therefore receive a successful backup download, lose or replace the live workspace, and discover only during recovery that the application's own archive was not restorable. A legacy backup had a related loss path: restore filtered out retained grants on archived pages before deleting the old pages, so the foreign-key cascade removed those grants permanently.

## Reproduction

The dependency-independent reproducer models and verifies the exact state transition:

```bash
npm run reproduce:archived-share-backup-loss
```

Vulnerable sequence:

1. Create an ordinary page and grant an editor access.
2. Archive the page; the grant remains stored but live collaboration is suspended.
3. Export the workspace; the export query includes the archived page and its grant.
4. Import the generated ZIP.
5. The old validator rejects the archived-page grant before restore, making the successful export unusable.

The reproducer also verifies that a collection target remains invalid after the correction.

## Correction

`src/lib/page-share-integrity.ts` now defines one policy for current and legacy restore paths:

- Ordinary pages are valid share targets during restore even when archived.
- Collections and missing pages remain invalid.
- Archive remains a live-collaboration suspension, not an implicit access-list deletion.
- A later unarchive restores the original collaboration access list.

`src/lib/data-transfer.ts` uses that policy in both manifest relationship validation and legacy-grant preservation. This makes every newly exported archived-page grant self-restorable and prevents the legacy page-deletion cascade from silently removing the retained grant.

## Regression coverage

- `tests/archived-share-backup-integrity.node.test.mjs` directly tests the restore policy and source wiring without third-party packages.
- `tests/data-transfer.routes.test.ts` includes a full export/import regression for an archived ordinary page with an editor grant.
- `scripts/verify-data-loss-guards.mjs` runs the reproducer and fails if either restore path regresses.

## Verification commands

```bash
node --experimental-strip-types --test tests/*.node.test.mjs
node --experimental-strip-types scripts/reproduce-archived-share-backup-loss.mjs
node scripts/verify-data-loss-guards.mjs
node --experimental-strip-types scripts/verify-collaboration.mjs
```

## Verification results

The completed dependency-independent validation produced:

- 50 durability tests passed, 0 failed.
- The dedicated vulnerable/fixed reproduction reported every expected condition as `true`.
- `verify-data-loss-guards.mjs` completed successfully.
- `verify-collaboration.mjs` completed successfully and syntax-checked 166 project files.
- The embedded `.git` directory was compared byte-for-byte with the uploaded archive and remained unchanged.

The complete Vitest/TypeScript suite could not be executed in the review sandbox because its configured package proxy did not provide the lockfile's `zod@3.25.76` archive. The project source did not cause that installation failure. Run the following in a normal networked development environment before release:

```bash
npm ci
npm run check
```

## External consistency references

- MariaDB transactions and row locks: https://mariadb.com/kb/en/start-transaction/ and https://mariadb.com/kb/en/for-update/
- MariaDB rollback behavior and implicit-commit boundaries: https://mariadb.com/kb/en/rollback/ and https://mariadb.com/kb/en/sql-statements-that-cause-an-implicit-commit/
- Yjs update persistence and replay properties: https://docs.yjs.dev/api/document-updates and https://docs.yjs.dev/tutorials/creating-a-custom-provider
