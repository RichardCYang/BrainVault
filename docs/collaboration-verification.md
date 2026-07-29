# Collaboration and data-loss fix verification

Verification date: 2026-07-29 (Asia/Seoul)

This document records the dependency-free checks completed for document lineage, browser durability, server-authoritative materialization, cross-instance room freshness, and stale-SQL attachment-position reconciliation. The delivery process also verifies that every regular file under the preserved `.git` directory is byte-for-byte unchanged from the uploaded archive.

## Completed checks

The following commands completed successfully in the delivery environment:

```text
npm run lockfile:check
[lockfile-registry] OK: 347 resolved URL(s) use approved portable registry hosts.

npm run reproduce:materialization-loss
vulnerable.permanentLossWindowReproduced: true
fixed.legacyCheckpointRequiresRematerialization: true
fixed.permanentLossWindowClosed: true

npm run reproduce:cross-instance-loss
vulnerable.permanentLossWindowReproduced: true
fixed.staleNormalWriteRejected: true
fixed.staleRoomInvalidated: true
fixed.permanentLossWindowClosed: true

npm run reproduce:recovery-write-loss
vulnerable.permanentLossWindowReproduced: true
fixed.storageFailure.rejectedWithDurabilityError: true
fixed.storageFailure.unprotectedEditBecameVisible: false
fixed.permanentLossWindowClosed: true

npm run reproduce:attachment-position-loss
vulnerable.permanentLossWindowReproduced: true
vulnerable.acknowledgedMoveSurvived: false
fixed.acknowledgedMoveSurvived: true
fixed.canonicalImmutableContentPreserved: true
fixed.missingAttachmentUsesSqlLocation: true
fixed.permanentLossWindowClosed: true

npm run test:durability
9 tests passed; 0 failed.

npm run verify:collaboration
[verify-collaboration] OK: ... cross-instance durable-room freshness, stale-SQL attachment-position fencing ... syntax for 137 file(s).

npm run verify:data-loss
[verify-data-loss-guards] OK: ... stale-SQL attachment-position fencing ...
```

Additional completed structural checks:

- every accepted Yjs update is persisted before room replacement, broadcast, and ACK;
- an ambiguous database COMMIT invalidates and reloads the room instead of acknowledging uncertain state;
- every normal and snapshot write compares the in-memory room tip with the durable tip while the page lock is held;
- relational materialization replays locked `page_yjs_updates` and does not trust duplicate browser title/block payloads;
- archive, permanent deletion, final-share removal, export, and workspace restore require an exact current materialization checkpoint;
- browser edits are staged and their full recovery candidate is persisted before the live document or direct-save network path can expose them;
- an existing attachment keeps its durable Yjs parent/order while immutable file metadata is refreshed from the canonical SQL row;
- a genuinely missing attachment can still be adopted from SQL, while tombstoned or invalid parents fail closed;
- session protocol `documentEpochProtocol: 2` and WebSocket subprotocol `brainvault-yjs-v2` prevent cached vulnerable writers from joining the patched server;
- the server-side decoder rejects malformed blocks, unsupported Yjs values, non-finite numbers, unsafe object keys, invalid hierarchy, and over-limit documents;
- exact `yjs@13.6.31` dependency and lockfile integrity pins remain unchanged;
- JavaScript/TypeScript syntax checks cover all 137 executable source and test files.

## Runtime dependency installation limitation

A clean `npm ci --no-audit --no-fund` could not be completed in the delivery environment. The injected internal npm gateway did not provide the existing locked `zod-3.25.76.tgz`, and an explicit public-registry override did not complete. The incomplete `node_modules` directory was removed.

Therefore this environment could not run:

- `npm run build`
- the complete Vitest suite
- MariaDB integration tests
- a real-browser multi-tab/WebSocket reconnect test

No dependency version or `package-lock.json` entry changed. On a machine with normal npm registry access and MariaDB, complete deployment validation with:

```bash
npm ci
npm run build
npm test
npm run db:migrate
```

## Deployment boundary

Stop every pre-fix application writer before starting the patched build, restart the server to close old WebSockets, and refresh all open browser tabs. Do not clear browser recovery storage during rollout. Protocol-1 session failures and `brainvault-yjs-v1` WebSocket upgrade failures are intentional fail-closed behavior.

The built-in room fan-out remains process-local. The durable-tip fence prevents a patched stale room from silently appending or compacting missing durable updates, but it is not cross-process live fan-out. Horizontal scaling still requires shared pub/sub and distributed update/room coordination.

## Archive and Git verification

The upload ZIP is the authority for `.git` bytes. The final packaging procedure restores/verifies all 28 regular `.git` files in place, computes the same path/size/SHA-256 manifest, safely extracts the delivery ZIP into a separate directory, compares every file byte-for-byte with the packaged work tree, and reruns the dependency-free verification suite from that extracted copy.
