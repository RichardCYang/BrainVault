# Periodic data-transfer cleanup overlap hardening

Date: 2026-09-15

## Scope

A follow-up CPU/memory/I/O audit reviewed every recurring `setInterval()` path after the existing collaboration, formatter, observer, and long-running-server hardening.

The application-instance heartbeat already has an in-flight guard, collaboration access revalidation already rejects overlap, and auth-session pruning already serializes its asynchronous database work. The periodic data-transfer temporary-file cleanup was the remaining asynchronous recurring task that could start a second run before the previous run settled.

## Reproduced problem

`src/server.ts` schedules `cleanupStaleDataTransferTempFiles()` every `min(ATTACHMENT_TEMP_MAX_AGE_MS, 10 minutes)`. The configuration permits `ATTACHMENT_TEMP_MAX_AGE_MS` down to 60 seconds. The cleanup walks the private data-transfer staging directory, stats entries, and may recursively remove stale directories.

Before this change, the interval callback launched the cleanup promise and returned immediately. If a slow or stalled filesystem made one cleanup last longer than the timer interval, subsequent ticks started additional scans of the same directory. Those overlapping tasks provide no correctness benefit and can multiply filesystem work, Promise retention, Worker Pool pressure, and callback work.

`scripts/reproduce-server-housekeeping-overlap.mjs` models the timer semantics deterministically. With 30 one-minute ticks and a five-minute cleanup duration, the legacy schedule starts 30 cleanups and reaches five concurrent runs; the guarded schedule starts six and never exceeds one concurrent run.

## Change

`src/server.ts` now keeps one `dataTransferCleanupInFlight` promise:

- a timer tick returns immediately while the previous cleanup is active;
- the marker is cleared in `finally`, including cleanup failures;
- the cleanup interval is explicitly cleared during graceful shutdown, just like the auth-session prune interval.

Startup cleanup still runs synchronously before the server begins accepting requests. The periodic cleanup cadence is unchanged when storage keeps up. If one run exceeds the interval, redundant overlapping runs are skipped and the next normal tick after completion performs the next cleanup.

## Regression and security invariants

The patch does not change authentication, authorization, request admission, file paths, stale-age calculation, delete criteria, restore journals, backup/restore formats, database schema, CSP, dependencies, runtime requirements, or the permissions applied to private runtime files. No user-visible feature is removed or delayed under normal operation.

Focused regression coverage is in `tests/server-housekeeping-resource-lifecycle.node.test.mjs`. Full original-versus-modified dependency-free Node test comparison and `.git` preservation are verified separately during packaging.

References:

- Node.js timers documentation: `setInterval()` schedules repeated callback execution at the configured delay.
- Node.js server performance guidance: avoid unnecessary expensive filesystem/Worker Pool activity and keep server work bounded.

## Validation in the supplied sandbox

- Deterministic reproduction: legacy model starts 30 cleanups and reaches five concurrent runs; guarded model starts six and stays at one concurrent run for the 30-tick / five-minute-duration scenario.
- Focused performance/resource regression set under Node's TypeScript stripping mode: 42/42 passed.
- Dependency-free built-in Node suite, original archive: 918 tests, 862 passed, 56 failed.
- Same suite, modified tree: 920 tests, 864 passed, 56 failed. The two additional passes are the new housekeeping lifecycle tests; all 56 failure descriptions are identical to the original archive.
- JavaScript syntax sweep: 409 files checked, 0 failures. `src/server.ts` also passes Node's TypeScript syntax check.
- Portable lockfile registry validation: 352 resolved URLs accepted.

The sandbox's default Node.js is 22.16.0 while BrainVault requires `^22.23.2 || ^24.18.1 || >=26.5.1` with `engine-strict=true`. The archive contains no `node_modules`, and dependency-backed verification that imports `tsx` cannot complete here. The runtime/security floor and package metadata were not weakened or changed to bypass that constraint.
