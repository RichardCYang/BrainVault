# Backup v5 completeness and metadata fidelity

## Scope

Review the full BrainVault workspace export/restore path after collection sharing, page comments, page-version history, navigation ordering, retained uploaded assets, and custom-icon retention were added.

The export is a **workspace-content backup**, not an account-security/database dump. Authentication credentials, MFA/passkeys, login/security history, mutation receipts, Yjs operational logs, recovery candidates, and server-side snapshot catalog rows remain operational/security state and are intentionally outside the portable archive.

## Findings

### 1. Current-format optional sections could validate while user-visible state was absent

Version 4 was extended compatibly several times. `collectionShares`, `pageComments`, and `navigationPageOrder` therefore remained optional so early v4 archives stayed importable. `pageShares` and account `theme` were also optional for older archives. That compatibility policy meant a *current-looking* v4 manifest with one of those sections absent could still pass schema validation and then take a legacy restore path.

This is not normal ZIP bit-rot (ZIP/entry validation catches ordinary corruption), but it is an avoidable completeness ambiguity in the manifest contract.

**Fix:** version 5 is now the current export format. v5 requires the current user-visible workspace sections explicitly, while v1-v4 imports remain supported. v5 also requires page cover coordinates and ID-bound page-share identities that every current exporter already writes.

### 2. Collection-share `updated_at` was not exported

`collection_shares.updated_at` is returned by the collection-sharing API and changes when a grant is modified, but v4 exported only `created_at`. Restore inserted both database timestamps from `created_at`, so a permission edit timestamp was silently rewritten.

**Fix:** v5 exports and requires `updated_at`, includes it in restore conflict fingerprinting, preserves it in legacy-current-share snapshots, and inserts the original value during restore.

### 3. Owner navigation-order `updated_at` was recreated

Sidebar order is user-visible; its timestamp is metadata rather than ordering content, but the database value was nevertheless replaced during restore.

**Fix:** v5 exports and requires `navigationPageOrder[].updated_at`, fingerprints it, and restores the source timestamp. v4 archives without the timestamp retain their historical behavior.

### 4. Collaboration attribution is deliberately normalized on portable import

Page-comment authors and page-version actors from a user-controlled portable ZIP cannot authenticate another live account's authorship. The existing restore path therefore rebinds imported comments/history actors to the importer instead of allowing a crafted archive to impersonate another account.

This is a deliberate security transformation, not an accidental omission. Comment bodies/timestamps and version-history content remain present, but collaborator attribution is not byte-for-byte portable. This review intentionally keeps that anti-impersonation boundary rather than weakening it for nominal fidelity.

## Consistency and asset review

The server serializes export/restore with the workspace/user locking discipline, uses a repeatable-read transaction for multi-query state, stages uploaded assets while the boundary is held, validates declared ZIP paths and size/resource limits, verifies per-file CRC-32/SHA-256, and restores filesystem generations through staged replacement plus recovery journals. Retained attachment files and retained custom-icon files are included, not only files currently referenced by blocks/library rows.

A remaining boundary is inherently outside a server export: unsaved browser-local drafts or recovery state on another device are not server workspace data. The current browser blocks export when it detects owned-page local drafts/recovery still pending there; users should still allow all devices/tabs to finish synchronizing before taking a disaster-recovery backup.

## Regression coverage

`tests/backup-v5-completeness.node.test.mjs` locks the v5 requirements, v1-v4 compatibility, collection-share timestamp round trip, navigation-order timestamp round trip, and the existing anti-impersonation behavior.
