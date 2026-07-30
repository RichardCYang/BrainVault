# BrainVault data-integrity re-audit — cross-page block-deletion cascade

- Audit date: 2026-07-30
- Audited Git HEAD: `cc16e93`
- Scope: full uploaded project, database schema and migrations, page/block deletion, Yjs materialization, attachments, full backup/restore, and browser recovery
- `.git`: preserved exactly without deletion, reinitialization, commits, or garbage collection

## Conclusion

No new Critical path was found that would immediately and permanently delete the current note through normal UI or API requests. Existing protections for the durable Yjs log, server-authoritative materialization, deletion snapshots, attachment user locks, restore journal and generation markers, and ZIP CRC32/SHA-256 validation were still present in the reviewed source.

The audit did reproduce the following integrity gap in the database defense layer.

## BV-DI-2026-07-30-02 — cross-page cascade deletion through a single-column parent foreign key

### Impact

The previous `blocks.parent_block_id -> blocks.id ON DELETE CASCADE` constraint verified only that the parent block existed. It did not verify that the parent and child had the same `page_id`. The current REST, Yjs-materialization, and backup-restore code paths all validate same-page parents, so no path was found to create this state through normal remote requests alone.

However, if legacy data, manual SQL, an operations tool, a damaged migration, or a future write path created a cross-page parent reference once, normally deleting the parent block could cause the database cascade to permanently delete child blocks on another page. The application deletion snapshot collects only blocks from the target page, so those external children would not appear in the expected deletion set.

- Severity: Medium, defense-in-depth integrity
- Creatable through normal remote use: not identified
- Permanent loss when the corrupted state already exists: reproduced
- Possible cross-account impact: permitted by the previous schema

## Correction

1. New-install schema
   - Added a composite unique key on `(id, page_id)`.
   - Replaced the parent foreign key with `(parent_block_id, page_id) -> (id, page_id)`.
   - Normal same-page subtree cascades remain intact, while the database rejects cross-page references.

2. Upgrade migration `023_blocks_parent_page_integrity.sql`
   - Adds the composite key first.
   - Adds the composite foreign key through dynamic DDL only when it is absent.
   - Removes the legacy single-column foreign key only after the stronger constraint exists.
   - Accounts for MariaDB DDL implicit commits by using `information_schema` checks and prepared statements so each step is rerunnable.
   - If the existing database already contains cross-page parents, adding the foreign key fails closed. It does not delete or rewrite data automatically; an administrator must repair the rows first.

3. Reproduction and regression verification
   - `scripts/reproduce-cross-page-parent-cascade-loss.mjs`
   - `tests/cross-page-parent-integrity.node.test.mjs`
   - Integration in `scripts/verify-data-loss-guards.mjs`
   - Added `reproduce:cross-page-parent-loss` to `package.json`

## Reproduction results

Legacy single-column foreign-key model:

- A child on another page is accepted when only the parent ID matches: true
- Deleting the parent cascades to the child on the other page: true
- Permanent cross-page loss window: reproduced

Corrected composite foreign-key model:

- Cross-page parent reference rejected: true
- Normal same-page parent/child reference accepted: true
- Same-page subtree cascade preserved: true
- New-install schema and upgrade migration both use the composite foreign key: true

Run:

```bash
npm run reproduce:cross-page-parent-loss
node --experimental-strip-types --test tests/*.node.test.mjs
node scripts/verify-data-loss-guards.mjs
node --experimental-strip-types scripts/verify-collaboration.mjs
```

## Overall verification results

- Dependency-free durability tests: passed
- Data-loss source/reproduction verifier: passed
- Collaboration source/protocol/syntax verifier: passed
- Existing regressions for same-size ZIP mutation, structured metadata, sort order, Yjs bootstrap/materialization, and browser durable-before-visible behavior: passed

## Limitations

The audit environment's internal npm proxy returned `404` for `zod-3.25.76.tgz`, so `npm ci` could not complete. The full Vitest suite, formal TypeScript build, and live MariaDB migration integration were therefore not run in that environment. Before deployment, run the following in an environment with normal npm access and MariaDB:

```bash
npm ci
npm run check
npm run db:migrate
```

If migration `023` fails because cross-page parent data already exists, do not automatically rewrite the rows. Back them up and review them with the following diagnostic query, then reconnect each child to a valid parent on the same page or detach it by setting the parent to `NULL`.

```sql
SELECT child.id, child.page_id, child.parent_block_id, parent.page_id AS parent_page_id
FROM blocks child
JOIN blocks parent ON parent.id = child.parent_block_id
WHERE child.parent_block_id IS NOT NULL
  AND child.page_id <> parent.page_id;
```

## `.git` preservation

At the start of the audit, a SHA-256 manifest was created for the 28 regular files under `.git`. The final packaging check compares the same file count and hashes. The `.git` directory is not deleted, recreated, committed, or garbage-collected.
