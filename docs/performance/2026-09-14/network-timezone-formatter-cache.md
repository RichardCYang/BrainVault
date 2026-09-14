# Network time-zone formatter hot-path cache

Date: 2026-09-14

## Symptom and scope

A follow-up CPU audit found two request-frequency internationalization hot paths that were not covered by the earlier UI formatter cache pass.

1. `public/app.js` resolved the browser time zone with a fresh `Intl.DateTimeFormat()` every time network-verification headers were prepared. Normal authenticated API calls use that path, so the constructor cost scaled with request count even when the browser time zone had not changed.
2. When VPN access blocking is enabled, authenticated requests evaluate the client/IP time-zone mismatch. `src/lib/vpn-access-policy.ts` rebuilt `Intl.DateTimeFormat` objects for both time-zone validation and UTC-offset extraction. With cached network-provider facts this formatter construction could become a disproportionate share of the remaining per-request CPU work.

No continuously self-rescheduling animation loop or unconditional server busy loop was found in the reviewed timer paths. Existing recurring server timers remain bounded/unref'd or guarded against overlapping asynchronous work.

## Change

- The browser time zone is cached for five minutes. The cache is intentionally bounded in time so a long-lived tab can still pick up an operating-system time-zone change without paying formatter construction on every request.
- VPN time-zone validation and offset extraction now share one `Intl.DateTimeFormat` per exact time-zone identifier.
- The server cache is capped at 512 entries. Invalid identifiers are never inserted because constructor validation occurs before cache insertion.
- Reusing the formatter does not cache the offset itself; `formatToParts(date)` still evaluates the supplied date on every call, so DST transitions remain correct.
- VPN policy test cache reset also clears the formatter cache.

No database schema, persisted data, authentication/authorization decision, VPN block threshold, WebRTC signal, request header contract, dependency, runtime floor, or `.git` content is changed.

## Reproduction benchmark

Run:

```bash
node scripts/reproduce-network-timezone-formatter-hot-path.mjs
```

Sandbox result on Node.js v22.16.0 after warm-up, five timed samples:

| Workload | Calls/sample | Fresh-constructor median | Cached median | Speedup |
| --- | ---: | ---: | ---: | ---: |
| browser local time-zone resolution | 4,000 | 354.92 ms | 0.38 ms | 942.92x |
| server VPN time-zone mismatch comparison | 500 | 424.25 ms | 6.87 ms | 61.78x |

The benchmark verifies equal output checksums. These numbers isolate formatter work and are not claims that the entire application becomes 943x or 62x faster. The application-level benefit depends on API request rate and whether VPN blocking is enabled.

A separate pre-change reproduction using 1,200 server comparisons measured 1,307.86 ms with fresh constructors versus 12.46 ms with an equivalent shared cache (104.92x), confirming that the issue is reproducible independently of the final benchmark size.

## Regression protection

`tests/network-timezone-formatter-cache.node.test.mjs` verifies that:

- repeated browser time-zone reads construct only one formatter within the five-minute cache window and refresh after expiry;
- VPN validation and offset reads share one formatter per time zone;
- the 512-entry server cache bound remains present;
- the cached server formatter still returns different New York offsets in January and July, proving that DST-sensitive date evaluation is not frozen by the cache.

Focused dependency-free run:

```bash
node --test \
  tests/network-timezone-formatter-cache.node.test.mjs \
  tests/i18n-number-format-cache.node.test.mjs \
  tests/i18n-hot-path-cache.node.test.mjs \
  tests/i18n-date-time-format-cache.node.test.mjs \
  tests/long-running-server-latency.node.test.mjs
```

Result in this sandbox: **9/9 passed**.

Full dependency-free `tests/*.node.test.mjs` comparison under the same sandbox runtime:

- original archive: **909 tests, 853 passed, 56 failed**;
- optimized tree: **911 tests, 855 passed, 56 failed**;
- the **same 56 failure names** occur in both trees; there are **0 new failures** and **0 removed failures**.

The two extra passing tests are the new time-zone formatter cache regressions. The remaining failures are existing environment/runtime/dependency-bound tests under Node.js v22.16.0.

A standalone TypeScript syntax/type pass on `src/lib/vpn-access-policy.ts` with the globally available TypeScript 5.8.3 and `--noResolve` reports only the expected missing external/local module declarations and Node `Buffer` types; no diagnostic points at the modified formatter-cache lines.

## Environment note

The provided sandbox runtime is Node.js v22.16.0 while BrainVault declares `^22.23.2 || ^24.18.1 || >=26.5.1`. The runtime floor was not changed. Dependency-free tests and benchmarks above run without weakening project configuration; dependency-backed build/test verification is reported separately when available.
