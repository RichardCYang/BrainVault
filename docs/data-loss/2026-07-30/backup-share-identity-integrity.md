# Backup collaborator identity integrity

- Review date: 2026-07-30
- Severity: High
- Affected operation: complete workspace restore
- Integrity impact: an unrelated account could receive editor access and then modify or delete restored note data

## Executive summary

BrainVault backups previously represented each page-sharing grant with only the collaborator username. Usernames are unique inside one database, but they are not a stable cross-server account identity. When a backup was restored on another BrainVault server, an unrelated destination account with the same username could receive the restored `EDIT` grant silently.

The problem was reproducible without database corruption or a malformed ZIP:

1. Server A exported a page shared with account `usr_source_alice`, username `alice`.
2. Server B had a different account `usr_destination_alice`, also named `alice`.
3. Restore resolved the backup grant by username and inserted `usr_destination_alice` into `page_shares`.
4. BrainVault treats a matching `page_shares` row as the `EDITOR` role with write access.
5. The unrelated account could therefore edit or delete restored note blocks and attachment references.

The corrected format binds every new grant to both `shared_user_id` and `shared_username`. Restore locks and validates the exact account pair before any page deletion or attachment-directory replacement can begin.

## Root cause

The old manifest record was:

```json
{
  "page_id": "pag_shared",
  "shared_username": "alice",
  "permission": "EDIT",
  "created_at": "2026-07-30 00:00:00.000000"
}
```

The importer queried `users` by username and used whichever local account matched. That behavior confused a portable display/login name with authorization identity.

Because `getPageAccess()` maps a matching `page_shares.user_id` row to the `EDITOR` role and reports `canEdit: true`, the defect affected note-data integrity, not only access-list presentation.

## Correction

### New backup records

Every newly exported grant now includes:

```json
{
  "page_id": "pag_shared",
  "shared_user_id": "usr_source_alice",
  "shared_username": "alice",
  "permission": "EDIT",
  "created_at": "2026-07-30 00:00:00.000000"
}
```

### Exact identity validation

For ID-bound grants, restore now:

1. Collects the referenced account IDs.
2. Locks matching `users` rows with `SELECT ... FOR UPDATE`.
3. Requires both the account ID and username to match the backup record exactly.
4. Rejects missing accounts, renamed/mismatched accounts, and owner self-shares.
5. Completes all checks before the destructive workspace replacement phase.

A destination account that only shares the username is rejected with `INVALID_DATA_BACKUP` and the existing workspace remains unchanged.

### Legacy compatibility

Older backups can contain username-only `pageShares` records. A matching owner ID is not sufficient because a collaborator account can be deleted and another account can later reuse the same username on the same server. BrainVault therefore accepts each username-only record only when the destination workspace already contains the exact page-to-account sharing row and the locked account still has the recorded username. The restore preserves that current stable account ID; it never discovers a legacy collaborator by username alone.

A legacy username-only grant with no current exact sharing row fails before destructive replacement. This covers a clean destination server, a deleted-and-reregistered username, and a cross-server restore without an explicitly matching local grant. A manifest that mixes ID-bound and username-only grants is also rejected because no supported exporter emits that ambiguous combination.

Backups old enough to omit the entire `pageShares` field continue to use the existing `legacy-preserved` behavior: current grants for surviving ordinary page IDs are retained.

## Reproduction and regression coverage

Run the focused reproducer:

```bash
npm run reproduce:backup-share-identity-rebinding
```

It proves both states:

- Vulnerable behavior resolves an unrelated same-named account and models deletion of a private note block through the resulting editor grant.
- Corrected behavior rejects the unrelated account, accepts the exact ID-and-username pair, requires a current exact grant for username-only legacy records, rejects deleted-and-reregistered username reuse, and rejects mixed identity generations.

Regression coverage is in:

- `tests/backup-share-identity-integrity.node.test.mjs`
- `tests/backup-share-integrity.node.test.mjs`
- `tests/data-transfer.routes.test.ts`
- `scripts/verify-data-loss-guards.mjs`

The route-level regression verifies that an unrelated same-named destination account causes a 400 response before collaborator disconnect, `DELETE FROM pages`, or attachment replacement.

## Verification results

The corrected source passed:

```text
node --experimental-strip-types --test tests/*.node.test.mjs
56 tests passed, 0 failed

node scripts/verify-data-loss-guards.mjs
PASS

node --experimental-strip-types scripts/verify-collaboration.mjs
PASS; 168 files checked
```

TypeScript syntax checks also passed for the modified integrity helper and restore implementation.

The full dependency-backed Vitest and TypeScript build could not be rerun in the review environment because the configured internal npm mirror returned HTTP 404 for the pinned `zod@3.25.76` tarball during `npm ci --ignore-scripts`. This is an environment dependency-fetch limitation, not a passing claim for the unavailable suites.

## Operational compatibility note

A new backup restored onto an independent server will restore a collaborator grant only when that server contains the same account ID and username. A separately registered same-named account is deliberately not treated as the same principal. For a username-only legacy backup, the destination must already have the exact page-to-account grant; otherwise import fails before replacement. The owner can create a new current-format backup after explicitly reconciling destination-server collaborators.
