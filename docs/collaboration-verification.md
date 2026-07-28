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

npm run reproduce:cross-instance-loss
baselineCommit: 741dcc1a650e253f4556948a94a233f6fe1bf60e
vulnerable.permanentLossWindowReproduced: true
fixed.staleNormalWriteRejected: true
fixed.staleRoomInvalidated: true
fixed.permanentLossWindowClosed: true

npm run verify:collaboration
[verify-collaboration] OK: source wiring, exact Yjs dependency pins, recovery acknowledgement safety, document-lineage isolation, server-authoritative materialization provenance, cross-instance durable-room freshness, hierarchy invariants, RFC 6455 protocol behavior, and syntax for 131 file(s).

npm run verify:data-loss
[verify-data-loss-guards] OK: destructive ordering, server-authoritative collaboration materialization, cross-instance durable-room freshness fencing, provenance-fenced checkpoints, owner-scoped atomic browser exclusion, expiry-safe transition fencing, cross-tab recovery isolation, lossless malformed-record handling, seven locale messages, boundary-safe convergent storage snapshots, and fail-closed recovery inspection.
```

Additional completed structural checks:

- the materialization reproducer locates the vulnerable client-body data flow in preserved Git history instead of incorrectly assuming the current `HEAD` is vulnerable;
- the cross-instance reproducer locates the snapshot-only writer check in preserved Git history and proves the stale ordinary-write/compaction loss schedule;
- every patched WebSocket write compares the in-memory room tip with the durable tip while the page transaction lock is held, and stale rooms are invalidated before insertion or deletion;
- the updated route accepts only `documentEpoch` and `updateId` as meaningful request inputs and reads ordered `page_yjs_updates` under the page transaction lock;
- migration `022_server_authoritative_collaboration_materialization.sql` is non-destructive and defaults legacy checkpoints to provenance version `0`;
- final-share removal, archive, permanent delete, export, and workspace restore require an exact current-version materialization checkpoint;
- the server-side decoder rejects malformed blocks, unsupported Yjs values, non-finite numbers, unsafe object keys, invalid hierarchy, and over-limit documents instead of silently dropping content;
- migration and document-epoch wiring from migration 021 remains intact;
- exact `yjs@13.6.31` dependency and lockfile integrity pins remain unchanged;
- JavaScript/TypeScript syntax checks cover all 131 executable source and test files.
- the delivery ZIP was safely re-extracted; all 209 files and 30 directories matched the packaged working tree byte-for-byte;
- all 28 regular files under the extracted `.git` directory matched the upload-time SHA-256 manifest, including `HEAD`, `index`, refs, logs, and packed objects;
- both deterministic reproductions and both dependency-free verifiers passed again from the extracted archive.

## Runtime dependency installation limitation

A clean `npm ci --no-audit --no-fund` was attempted again after the patch. The configured package gateway returned HTTP 503 while retrieving the pre-existing locked dependency `zod-3.25.76.tgz`, and the local npm cache did not contain that tarball. Therefore this delivery environment could not run `npm run build`, the full Vitest suite, or MariaDB integration tests after a clean install.

No dependency version or `package-lock.json` entry changed. This follow-up adds only the dependency-free `reproduce:cross-instance-loss` command to `package.json`. On a machine with npm registry access and MariaDB, complete deployment validation with:

```bash
npm ci
npm run build
npm test
npm run db:migrate
```

## Deployment boundary

Apply migrations 021 and 022 before serving the updated application. Migration 022 does not delete or rewrite Yjs history. Existing non-empty collaboration histories retain version `0` until an updated browser requests materialization and the server successfully rebuilds SQL state from the durable Yjs log. Until then, destructive/replacement operations fail closed with `COLLABORATION_CHANGES_PENDING`.

Browser tabs that still run the pre-fix client should be refreshed. Their extra snapshot fields are ignored by the updated server, and document-epoch capability negotiation continues to prevent legacy recovery replay. Do not clear browser recovery storage during rollout.

The included room fan-out remains process-local. The new durable-tip fence prevents a patched stale room from silently appending or compacting missing durable updates, but it is not cross-process live fan-out. Run one active BrainVault application process for normal operation. Horizontal scaling still requires shared pub/sub and distributed update/room coordination. During rollout, stop every pre-fix writer before starting patched instances; overlapping an old process with a patched process preserves the old loss window.
