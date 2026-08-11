# Backup workspace-state round-trip integrity review

Date: 2026-08-11

## Scope

This review traced the complete-data export and restore path from the browser Data settings route through ZIP transport, manifest validation, database replacement, uploaded-asset generation swaps, and the user-visible tables that depend on owned pages. Existing backup integrity reproductions for stream checksum enforcement, HTTP truncation, custom covers, sharing grants and collaborator identity, archived sharing, structured block metadata, attachment metadata, retained attachment files, and uploaded custom icons were rerun before changing the format.

The review intentionally distinguishes user-visible workspace state from internal recovery/idempotency state. The historical Yjs update log, collaboration materialization rows, restore markers, and mutation receipt tables remain operational state rather than exported workspace history. Authentication credentials, MFA/passkeys, login history, and login-access security policies also remain outside workspace backup scope.

## Finding: successful v3 restore deleted user-visible page history

`page_versions.page_id` references `pages.id` with `ON DELETE CASCADE`. Restore starts its database replacement with `DELETE FROM pages WHERE owner_id = ?`. Backup v3 did not serialize `page_versions`, and its importer did not recreate those rows. Therefore a restore could return success while every Version history entry for the restored account's pages was permanently removed.

This is effective data loss because Version history is a normal user-facing page feature, separate from the intentionally excluded historical Yjs transport log.

## Finding: successful v3 restore deleted owned-page navigation collapse state

`user_navigation_collapsed_pages.page_id` also references `pages.id` with `ON DELETE CASCADE`. The same destructive page replacement deleted the account's saved collapse/expand state for owned pages, while backup v3 carried no corresponding data. The workspace remained usable after restore, so this loss was silent rather than a restore failure.

Only collapse state for owned pages belongs to this replacement boundary. Preferences for pages owned by another account are not exported because those pages themselves are not part of this account's backup and are not deleted by the restore.

## Correction: backup format v4

Current exports use backup format v4. The manifest now includes:

- every `page_versions` row for pages owned by the exporting account, including revision, page/content edit versions, actor snapshots, source, change summary, full change payload, and timestamp;
- the set of owned page IDs currently stored in `user_navigation_collapsed_pages` for the exporting account.

The manifest relation validator rejects duplicate `(page_id, revision)` history entries, duplicate collapsed-page IDs, references to pages that are not present in the same backup, and history edit/content versions that exceed the corresponding exported live page version. Resource accounting includes a dedicated page-version count limit, while the existing total manifest and archive byte limits continue to fail closed rather than silently omit records.

Restore recreates both relations in the same database transaction after the pages have been recreated. Backups v1, v2, and v3 remain importable; because those historical formats never contained these relations, they retain their historical behavior rather than pretending that omitted state can be reconstructed.

## Cross-server account-ID rebinding

A complete backup may be restored into a newly created account whose internal ID differs from the source account. v3 already rebound live local custom-icon paths. v4 extends that semantic rebinding to Version history:

- actor snapshots whose ID is the source account ID are rebound to the destination account ID;
- page-history `icon` values in baseline/page-created/page-updated records are rebound when they reference `/upload/icons/<sourceUserId>/...`.

Other actor snapshots remain historical identity snapshots and are not rewritten.

## Concurrency correction

Restore already uses a user-row lock and compares an initial workspace fingerprint with a locked fingerprint immediately before replacement. v4 adds page-version rows and owned-page navigation-collapse state to that fingerprint. A history reset or navigation preference change that occurs while a restore archive is being staged can therefore cause `DATA_RESTORE_CONFLICT` instead of being overwritten by stale destination state.

The navigation-preference PATCH route now takes the same per-user row lock inside its transaction before it mutates `user_navigation_collapsed_pages`. This serializes those writes with backup/restore so the exported navigation state belongs to the same protected account generation as the rest of the backup.

## Reproduction

Run:

```bash
npm run reproduce:backup-workspace-state-loss
```

The reproducer reads the preserved Git `HEAD` version as the vulnerable baseline and compares it with the working tree. It proves that the baseline restore deletes pages whose foreign-key cascades remove both user-visible relations, while the current v4 source exports, validates, fingerprints, and reinserts both relations. It also models destination-account rebinding for history actor IDs and local custom-icon references.

A dependency-free regression test is included in `tests/backup-workspace-state-integrity.node.test.mjs` and runs as part of `npm run test:durability`.

## Verification results

On 2026-08-11, after the correction:

- `npm run test:durability`: **254/254 passed**.
- `node --test tests/backup-workspace-state-integrity.node.test.mjs`: **2/2 passed**.
- `npm run reproduce:backup-workspace-state-loss`: reproduced both vulnerable losses and confirmed the corrected round trip.
- The pre-existing backup reproductions for stream integrity, transport truncation, page covers, sharing, collaborator identity, archived sharing, structured metadata, attachment metadata, and complete uploaded assets were rerun after the v4 change and remained green.

A full dependency-backed TypeScript build/unit run could not be completed in this audit sandbox because the project was supplied without `node_modules` and package retrieval from the npm registry failed with `EAI_AGAIN`. The installed sandbox Node runtime was also 22.16.0, below this repository's declared 22.23.2 minimum. Dependency-free TypeScript-aware durability tests and source-level verification were therefore used for the final regression gate, and no generated dependency directory is included in the corrected archive.

## Preserved exclusions

The following remain intentionally outside complete workspace backup:

- password hash and authentication/session versioning;
- TOTP credentials, passkeys, setup/challenge/session material;
- login-attempt history, country-login policy/history, and VPN access policy;
- historical Yjs update log and current collaboration materialization bookkeeping;
- mutation receipt/idempotency tables and restore journal markers.

These exclusions are not deleted/replaced as exported workspace content, except page-tied operational rows that naturally disappear when a page generation is replaced. The restored page/block state becomes the new authoritative collaboration generation.
