# Collaboration and data-loss fix verification

Verification date: 2026-07-28 (Asia/Seoul)

This document records the checks completed for the document-lineage, browser-durability, and server-authoritative collaboration-materialization fixes. The delivery process also verifies that every file under the preserved `.git` directory is byte-for-byte unchanged from the uploaded archive.

## Completed checks

The following commands completed successfully in the delivery environment:

```text
npm run lockfile:check
[lockfile-registry] OK: 347 resolved URL(s) use approved portable registry hosts.

npm run reproduce:materialization-loss
baselineCommit: 54e22e141308c394006b1c23ab34aa22b63e8097
vulnerable.permanentLossWindowReproduced: true
fixed.legacyCheckpointRequiresRematerialization: true
fixed.permanentLossWindowClosed: true

npm run verify:collaboration
[verify-collaboration] OK: source wiring, exact Yjs dependency pins, recovery acknowledgement safety, document-lineage isolation, server-authoritative materialization provenance, hierarchy invariants, RFC 6455 protocol behavior, and syntax for 129 file(s).

npm run verify:data-loss
[verify-data-loss-guards] OK: destructive ordering, server-authoritative collaboration materialization, provenance-fenced checkpoints, owner-scoped atomic browser exclusion, expiry-safe transition fencing, cross-tab recovery isolation, lossless malformed-record handling, seven locale messages, boundary-safe convergent storage snapshots, and fail-closed recovery inspection.
```

Additional completed structural checks:

- the preserved Git `HEAD` route still contains the vulnerable client-body data flow used by the deterministic reproduction;
- the updated route accepts only `documentEpoch` and `updateId` as meaningful request inputs and reads ordered `page_yjs_updates` under the page transaction lock;
- migration `022_server_authoritative_collaboration_materialization.sql` is non-destructive and defaults legacy checkpoints to provenance version `0`;
- final-share removal, archive, permanent delete, export, and workspace restore require an exact current-version materialization checkpoint;
- the server-side decoder rejects malformed blocks, unsupported Yjs values, non-finite numbers, unsafe object keys, invalid hierarchy, and over-limit documents instead of silently dropping content;
- migration and document-epoch wiring from migration 021 remains intact;
- exact `yjs@13.6.31` dependency and lockfile integrity pins remain unchanged;
- JavaScript/TypeScript syntax checks cover all 129 executable source and test files.

## Runtime dependency installation limitation

A clean `npm ci --no-audit --no-fund` was attempted again after the patch. The configured package gateway returned HTTP 503 while retrieving the pre-existing locked dependency `zod-3.25.76.tgz`, and the local npm cache did not contain that tarball. Therefore this delivery environment could not run `npm run build`, the full Vitest suite, or MariaDB integration tests after a clean install.

No dependency version or `package-lock.json` entry was changed. `package.json` only gained the deterministic `reproduce:materialization-loss` command. On a machine with npm registry access and MariaDB, complete deployment validation with:

```bash
npm ci
npm run build
npm test
npm run db:migrate
```

## Deployment boundary

Apply migrations 021 and 022 before serving the updated application. Migration 022 does not delete or rewrite Yjs history. Existing non-empty collaboration histories retain version `0` until an updated browser requests materialization and the server successfully rebuilds SQL state from the durable Yjs log. Until then, destructive/replacement operations fail closed with `COLLABORATION_CHANGES_PENDING`.

Browser tabs that still run the pre-fix client should be refreshed. Their extra snapshot fields are ignored by the updated server, and document-epoch capability negotiation continues to prevent legacy recovery replay. Do not clear browser recovery storage during rollout.

The included room fan-out remains process-local. Run one BrainVault application process for this version. Horizontal scaling requires shared pub/sub and distributed update/room coordination before multiple application instances can safely serve the same collaboration rooms.
