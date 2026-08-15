# Localized date/time formatter reuse

Date: 2026-08-15

## Optimization target

Browser rendering paths repeatedly created identical `Intl.DateTimeFormat` instances while showing account/session timestamps, AI-chat answer times, Gantt headers/month groups, and timetable dates. Constructing an internationalization formatter performs locale/options setup that is reusable for these pure presentation operations.

## Change

`public/i18n.js` now provides `formatDateTime()`, backed by a lazy cache keyed by the active locale plus a canonicalized formatter-options key. Reordered but equivalent option objects therefore reuse the same formatter. The account/session timestamp, AI-chat, Gantt, and timetable rendering paths use this shared formatter cache.

The cache is presentation-only. It does not change API requests, authentication/authorization, browser time-zone signaling, database access, collaboration state, save queues, backup/restore formats, uploaded files, or any persistence/mutation path. In particular, the existing per-request browser time-zone detection used for network-access policy is intentionally unchanged.

## Reproducible regression protection

`tests/i18n-date-time-format-cache.node.test.mjs` uses only Node built-ins. It replaces `Intl.DateTimeFormat` with a counting wrapper and verifies that:

- representative timestamps format exactly like fresh native formatters for all seven supported locales;
- all date/time option sets used by the optimized UI paths preserve exact output;
- repeated calls construct at most one formatter for each locale/options pair;
- equivalent options supplied in a different property order reuse the same cached formatter.

The full built-in Node regression suite is also compared before and after the change so pre-existing environment-dependent failures can be distinguished from new regressions.

## Measured result

A five-run microbenchmark formats the same Korean-locale timestamp 20,000 times after a 1,000-call warm-up in a fresh Node process per run. The output checksum is identical (`420000`) before and after.

- original median: **909.40 ms**
- optimized median: **49.44 ms**
- median speedup: **18.39×**
- elapsed-time reduction: **94.56%**

This benchmark isolates repeated formatter construction/reuse. It is not a claim that the whole application becomes 18.39× faster; the benefit is limited to UI paths that repeatedly render localized dates/times.

## Sandbox verification note

The sandbox runtime is Node.js 22.16.0, below BrainVault's declared runtime floor (`^22.23.2 || ^24.18.1 || >=26.5.1`). The runtime requirement was not changed or bypassed in the project. Dependency installation with the project's normal `npm ci` correctly stops with `EBADENGINE`; an environment-only attempt to bypass that install check also could not complete in this sandbox, so dependency-backed Vitest/build checks could not be installed here. Built-in Node tests and source verification were compared on the exact same sandbox runtime before and after this optimization.
