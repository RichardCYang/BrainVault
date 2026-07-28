# Collaboration and data-loss fix verification

Verification date: 2026-07-28 (Asia/Seoul)

This document records the checks actually completed for the document-lineage data-loss fix. The delivered archive is accompanied by an external machine-readable integrity report for the preserved `.git` directory.

## Completed checks

The following commands completed successfully in the delivery environment:

```text
npm run lockfile:check
[lockfile-registry] OK: 347 resolved URL(s) use approved portable registry hosts.

npm run verify:collaboration
[verify-collaboration] OK: source wiring, exact Yjs dependency pins, recovery acknowledgement safety, document-lineage isolation, hierarchy invariants, RFC 6455 protocol behavior, and syntax for 121 file(s).

[recovery-lineage-smoke] OK
[openapi-yaml] OK
[migration-021-safety] OK
```

Additional completed structural checks:

- OpenAPI 3.1 YAML parsing and required document-epoch request/response fields
- non-destructive, rerunnable migration shape for `document_epoch`
- exact `yjs@13.6.31` dependency and lockfile integrity pin
- session capability negotiation that rejects pre-fix open tabs
- epoch-bound JWT, WebSocket room, database update, compaction, and materialization paths
- server-session-before-browser-recovery ordering
- same-tab recovery coexistence across multiple document epochs
- schema-v1 and undecodable recovery-record preservation
- mixed-epoch manual recovery rejection
- syntax checking for all 121 scanned JavaScript/TypeScript source files

## Runtime dependency installation limitation

A clean install was attempted with the existing lockfile. The configured package gateway returned HTTP 503 while retrieving the pre-existing `zod` dependency (`zod-3.25.76.tgz`), and the offline npm cache did not contain that tarball. Therefore this delivery environment could not run `npm run build`, the full Vitest suite, or MariaDB integration tests after the clean install attempt. This is an environment-level package-fetch limitation; neither `package.json` nor `package-lock.json` was changed.

On a machine with npm registry access and MariaDB, perform the remaining deployment checks with:

```bash
npm ci
npm run build
npm test
npm run db:migrate
```

## Deployment boundary

Apply migration `021_collaboration_document_epoch.sql` before serving the updated application. Browser tabs that still run the pre-fix client are intentionally denied a new collaboration session until refreshed. Do not clear browser recovery storage during rollout.

The included room fan-out remains process-local. Run one BrainVault application process for this version. Horizontal scaling requires shared pub/sub and distributed update/room coordination before multiple application instances can safely serve the same collaboration rooms.
