# Intl formatter hot-path cache hardening

Date: 2026-09-14

## Scope

This pass investigated excessive CPU usage in BrainVault with an emphasis on code that can execute repeatedly while rendering account/security data and note metadata. The audit also reviewed recurring browser/server timers and animation-frame scheduling for accidental busy loops.

No unconditional busy loop or continuously self-rescheduling `requestAnimationFrame` loop was found. The recurring server timers are bounded housekeeping/heartbeat work, are `unref()`'d, and the asynchronous database-facing loops that can overlap have in-flight guards. The page-transition browser lease timer is cleared in `finally`.

Two avoidable formatter-construction hot paths were reproduced:

1. snapshot and attachment size formatting constructed a fresh `Intl.NumberFormat` for every non-byte value, bypassing the existing i18n number-format cache;
2. login/security country rendering and the 249-country policy selector constructed a fresh `Intl.DisplayNames` for every region label.

## Change

`public/i18n.js` now:

- caches `Intl.NumberFormat` by locale plus normalized formatter options;
- keeps the existing no-options behavior while allowing hot paths to pass options through `formatNumber(value, options)`;
- caches one `Intl.DisplayNames({ type: "region" })` instance per locale;
- exports `formatRegionName()` so high-volume country rendering does not construct formatters directly;
- reuses the same deterministic option-key helper for number and date/time formatter caches.

`public/app.js` now routes both size-formatting paths and both region-label paths through the shared i18n caches.

No database schema, persistence format, authentication/authorization behavior, collaboration protocol, dependency, runtime floor, or `.git` content is changed.

## Reproduction benchmark

Run:

```bash
node scripts/reproduce-intl-formatter-hot-path.mjs
```

The script compares equivalent fresh-constructor reference work with the optimized shared-cache implementation, performs seven timed samples after warm-up, and fails if the output checksums differ.

Sandbox result on Node.js v22.16.0:

| Workload | Calls/sample | Fresh-constructor median | Cached median | Speedup | Median time reduction | Checksum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| localized size number formatting | 14,000 | 416.59 ms | 25.11 ms | 16.59× | 93.97% | 77,608 |
| localized region display names | 6,972 | 116.37 ms | 18.50 ms | 6.29× | 84.11% | 59,984 |

These are isolated formatter hot-path measurements, not claims that the complete application is 16.59× or 6.29× faster. The benefit is concentrated in renders that previously created many identical internationalization formatter objects.

## Regression protection

Focused built-in tests:

```bash
node --test tests/i18n-number-format-cache.node.test.mjs tests/i18n-hot-path-cache.node.test.mjs
```

Result: **3/3 passed**.

The tests verify:

- output equality with native fresh formatters across all supported locales;
- one number formatter construction per locale/options pair;
- one region display-name formatter construction per locale;
- the high-volume `public/app.js` call sites no longer instantiate `Intl.NumberFormat` or `Intl.DisplayNames` directly.

Full dependency-free Node test comparison in this sandbox:

- original archive: **907 tests, 851 passed, 56 failed**;
- optimized tree: **909 tests, 853 passed, 56 failed**;
- **0 new failure names** and **0 removed failure names**; the same 56 environment/dependency/runtime-bound failures remain.

Portable lockfile registry validation also passes: **352/352 resolved URLs use approved portable registry hosts**.

## Environment limitation

The sandbox has Node.js **v22.16.0** and no `node_modules`. BrainVault intentionally declares `^22.23.2 || ^24.18.1 || >=26.5.1` with `engine-strict=true`. The project runtime floor was not weakened or bypassed, so dependency-backed TypeScript/Vitest/build execution was not forced under an unsupported runtime. Syntax checks, dependency-free tests, source audits, and the reproducible microbenchmark were run directly instead.

## `.git` preservation

The `.git` directory was never operated on with Git commands. A pre-change manifest and a post-change manifest contain the same **28 files**, and every relative path, byte length, and SHA-256 digest is identical.
