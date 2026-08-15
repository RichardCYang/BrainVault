# Localized number formatter reuse

Date: 2026-08-15

## Optimization target

`public/i18n.js` previously created a new `Intl.NumberFormat` instance on every `formatNumber()` call. Number formatting is used throughout the workspace, including accordion ordering, database row/group counts, search counts, login/security history, Kanban positions, table accessibility labels, backup summaries, and attachment sizes. Reconstructing the same locale formatter repeatedly performs locale setup that can be reused safely.

## Change

`formatNumber()` now lazily caches one `Intl.NumberFormat` instance for each locale and reuses it for subsequent calls. The cache is keyed by the already-supported locale string, so changing the BrainVault language immediately selects the formatter for that locale and switching back reuses the prior formatter. At most seven default formatter instances are retained because BrainVault currently supports seven languages.

No translation catalog, locale mapping, API, database schema, persistence format, collaboration state, authentication/authorization behavior, upload/restore path, dependency, runtime setting, or `.git` content is changed.

## Reproducible regression protection

`tests/i18n-number-format-cache.node.test.mjs` uses only Node built-ins to verify that:

- all supported languages format representative integers, decimals, negatives, and `Number.MAX_SAFE_INTEGER` exactly like a fresh native `Intl.NumberFormat` for the same locale;
- repeated calls construct at most one formatter per supported locale;
- switching away from and back to Korean preserves the exact output and reuses the cached Korean formatter.

The existing accordion/i18n regression test and the previously added emoji lazy-loading, icon-operation, and lossless PNG tests remain unchanged and pass together with the new test.

## Measured result

A five-run microbenchmark formats the same 50,000 Korean-locale values after a 1,000-call warm-up in a fresh Node process per run. The output checksum is identical (`484595`) before and after.

- original median: **1,653.63 ms**
- optimized median: **52.06 ms**
- median speedup: **31.76×**
- elapsed-time reduction: **96.85%**

This benchmark intentionally isolates formatter construction/reuse; it is not a claim that whole-page rendering becomes 31.76× faster. The end-user benefit is concentrated in render paths that format many localized counts or positions.

## Sandbox regression comparison

The provided sandbox runtime is Node.js 22.16.0, below BrainVault's declared security floor (`^22.23.2 || ^24.18.1 || >=26.5.1`), and the archive does not contain `node_modules`. The runtime floor was not weakened or bypassed. A supported Node.js 24.18.1 binary was identified from the official Node.js distribution, but this sandbox could not download executable archives or reach the npm registry, so dependency-backed TypeScript/Vitest/build checks could not be installed here.

Tests that require no dependency installation were compared under the same sandbox runtime:

- focused regression set: **17/17 passed**;
- all `tests/*.node.test.mjs`, original: **205 tests, 170 passed, 35 failed**;
- all `tests/*.node.test.mjs`, optimized: **206 tests, 171 passed, 35 failed**;
- the same **35 pre-existing failure names** remained in both runs, with no new failure name;
- lockfile portable-registry verification passed in both trees;
- data-loss, collaboration, and security verification commands produced the same pre-existing environment/source-guard failures in both trees.

The inability to run dependency-backed checks is environmental. No dependency, engine, security, persistence, or install policy was changed to force a green result.
