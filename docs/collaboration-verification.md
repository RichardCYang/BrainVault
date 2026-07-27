# Collaboration implementation verification

Verification date: 2026-07-27 (Asia/Seoul)

This document records the checks performed on the completed page-sharing and Yjs collaboration implementation. The archive delivered with this project is accompanied by a machine-readable integrity proof that independently verifies the preserved `.git` directory against the uploaded source archive.

## Completed checks

The following commands completed successfully in the delivery environment:

```text
npm run lockfile:check
[lockfile-registry] OK: 347 resolved URL(s) use approved portable registry hosts.

npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund
up to date

npm run verify:collaboration
[verify-collaboration] OK: source wiring, exact Yjs dependency pins, hierarchy invariants, RFC 6455 protocol behavior, and syntax for 112 file(s).

node --check public/app.js
node --check public/collaboration.js
node --check public/i18n.js
```

Additional structural checks completed successfully:

- OpenAPI 3.1 YAML parsing and presence of all share/session/snapshot operations
- CSS brace balance and unique collaboration UI element IDs
- Migration presence for `page_shares`, `page_yjs_updates`, and `page_collaboration_state`
- exact `yjs@13.6.31` dependency and lockfile integrity pin
- original worktree `.git` versus modified worktree `.git`, including every file/symlink byte, Unix mode, size, and nanosecond timestamp
- uploaded ZIP `.git` entries versus delivery ZIP `.git` entries, including entry names, uncompressed bytes, ZIP timestamps, compression method, Unix attributes, extra fields, and comments
- clean extraction of the uploaded ZIP versus clean extraction of the delivery ZIP for the entire `.git` tree
- delivery ZIP payload versus the completed worktree for all included non-`.git` files

## Runtime dependency installation limitation

A full clean installation was attempted with:

```text
npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=10000
```

The configured package gateway returned HTTP 503 while retrieving the pre-existing `zod` dependency (`zod-3.25.76.tgz`). The offline cache also did not contain that tarball. Therefore this isolated delivery environment could not execute `npm run build`, the full Vitest suite, or MariaDB integration tests after a clean install. This is an environment-level package-fetch failure rather than a lockfile inconsistency: the offline package-lock-only consistency check and portable registry check both passed.

On a machine with npm registry access and MariaDB, perform the final deployment checks with:

```bash
npm ci
npm run build
npm test
npm run db:migrate
```

## Collaboration-specific coverage included in the project

The source verifier and added tests cover:

- authenticated RFC 6455 upgrade and frame handling
- page-scoped, short-lived collaboration tickets
- owner-only share management and immediate revocation disconnects
- Yjs update validation in an isolated server document before persistence
- deterministic update merge, malformed update rejection, and maximum-state enforcement
- first-client bootstrap and reconnect/full-state recovery
- stale snapshot rejection and transactional relational materialization
- block hierarchy, cycle, depth, duplicate-ID, and global-ID conflict checks
- attachment creation through the authenticated upload route only
- attachment deletion tombstone precedence during concurrent edits
- pending-update guards before final share removal, archive, or permanent deletion
- live presence and editing-focus display

## Deployment boundary

The included room fan-out is process-local. Run one BrainVault application process for this version. Horizontal scaling requires shared pub/sub and distributed update/room coordination before multiple application instances can safely serve the same collaboration rooms.
