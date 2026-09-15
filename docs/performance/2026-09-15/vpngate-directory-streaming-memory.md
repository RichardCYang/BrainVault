# VPN Gate directory streaming memory hardening

Date: 2026-09-15

## Scope

This audit reviewed BrainVault for avoidable CPU and memory retention with emphasis on long-lived server resources and browser/session lifecycle boundaries. The review covered:

- recurring `setInterval`/`setTimeout` work and overlap guards;
- collaboration room eviction, Yjs document teardown, WebSocket lifecycle, and collaboration Worker limits/termination;
- module-scope `Map`/`Set` caches and their entry caps/expiry cleanup;
- browser `IntersectionObserver`, requestAnimationFrame, menu/scroll, draft/save, and preview-cache lifecycles;
- bounded external HTTP response readers and full-body materialization;
- data-transfer and attachment concurrency gates.

The existing recurring housekeeping, collaboration, cache, observer, and worker paths were already bounded or explicitly torn down. The reproducible remaining hot spot was the VPN Gate relay-directory refresh path.

## Reproduced issue

`src/lib/vpngate-relays.ts` allowed at most 8 MiB of relay-directory bytes, but the old refresh path simultaneously materialized several representations of the same response:

1. every `ReadableStream` chunk was copied with `Buffer.from(value)`;
2. all copied chunks were retained until EOF;
3. `Buffer.concat()` allocated another full response buffer;
4. `.toString("utf8")` allocated the full text;
5. `text.split(/\r?\n/)` materialized the line list before row processing.

The 20,000 accepted-row cap therefore limited directory entries but did not prevent transient response duplication.

Two other bounded readers (`src/lib/vpn-access-policy.ts` and `src/lib/geo-country.ts`) also copied each fetch chunk once with `Buffer.from(value)` before the unavoidable final concatenation. Their response limits are smaller, so the fix there is deliberately minimal: retain the `Uint8Array` chunks directly and let `Buffer.concat()` perform the single required copy.

## Change

`src/lib/vpngate-relays.ts` now:

- incrementally decodes and parses newline-delimited CSV chunks with `TextDecoder`;
- keeps at most the unfinished line plus the bounded relay map instead of a complete binary body, complete text body, and complete line array at the same time;
- stops decoding/parsing once the existing 20,000 accepted-row limit is reached, while still reading the remaining raw stream bytes so the 8 MiB security limit cannot be bypassed;
- preserves the existing `Content-Length` precheck, raw-byte counter, over-limit cancellation, endpoint, redirect policy, hostname/IP validation, four-hostname-per-IP cap, stale/fail-closed behavior, and cache timing;
- keeps `parseVpnGateCsv()` behavior compatible for non-network callers while avoiding the extra `lines.slice()` array.

`src/lib/vpn-access-policy.ts` and `src/lib/geo-country.ts` now store the `Uint8Array` chunks returned by the fetch reader directly rather than immediately copying each chunk into a second Buffer.

No database schema, persistence format, authentication/authorization rule, collaboration protocol, dependency, runtime floor, or `.git` content is changed.

## Reproduction benchmark

A child-process harness imported the original archive module and the fixed module under the same Node.js executable, replaced the network fetch with the same deterministic `ReadableStream`, and replayed a 7.75 MiB directory consisting of a valid header, 20,000 accepted rows, and bounded padding. `/usr/bin/time -v` captured process maximum RSS. Seven independent samples were collected for each tree.

Sandbox result on Node.js v22.16.0:

| Metric | Original median | Fixed median | Change |
| --- | ---: | ---: | ---: |
| Maximum RSS | 103,348 KiB | 88,248 KiB | -15,100 KiB (-14.61%) |
| Refresh elapsed time | 74.25 ms | 57.784 ms | -22.18% (1.28x) |

Observed ranges:

- original RSS: 103,216-103,476 KiB;
- fixed RSS: 85,576-88,372 KiB;
- original elapsed: 69.916-77.719 ms;
- fixed elapsed: 55.607-62.008 ms.

This is an isolated worst-case directory-refresh measurement, not a claim that the complete application uses 14.61% less memory or is 1.28x faster overall. The benefit occurs during relay-directory refreshes.

A deterministic 1,000-input differential parser corpus (seed `0x6d2b79f5`) also compared the original archive's exported `parseVpnGateCsv()` with the fixed implementation across LF/CRLF, header position/order, valid and invalid IPs/hostnames/country codes, ignored rows, and malformed first headers. Result: **1,000/1,000 equivalent**.

## Regression protection

Focused dependency-free tests:

```bash
node --experimental-strip-types --test \
  tests/vpngate-streaming-resource.node.test.mjs \
  tests/vpngate-refresh-latency.node.test.mjs \
  tests/vpn-access-policy.node.test.mjs
```

The new tests cover:

- no duplicate full-body Buffer materialization in VPN Gate refresh;
- removal of redundant per-chunk `Buffer.from()` copies in the other bounded readers;
- arbitrary byte/chunk boundaries, UTF-8 prefix data, CRLF, and quoted CSV fields;
- the unchanged 20,000 accepted-row limit;
- the unchanged four-hostname-per-IP limit;
- continued raw-byte counting after the parser reaches its row cap;
- cancellation and fail-closed behavior for a chunked body above 8 MiB;
- rejection of an oversized declared `Content-Length` before the body is accessed;
- stale-while-refresh latency behavior and existing VPN policy wiring.

## Environment limitation

The sandbox provides Node.js v22.16.0 while BrainVault intentionally requires `^22.23.2 || ^24.18.1 || >=26.5.1` with `engine-strict=true`. The npm registry was not usable from this sandbox, so the project runtime floor was not weakened and dependency-backed build/Vitest execution was not forced on an unsupported runtime. Dependency-free Node tests, direct TypeScript type-stripping imports used by the existing tests, static source audits, the differential parser check, and the isolated RSS benchmark were used instead.

Final dependency-free regression results:

- original archive: **1,105 tests, 1,091 passed, 14 failed**;
- fixed tree: **1,112 tests, 1,098 passed, 14 failed**;
- the **same 14 failure names** remain, so the change introduced **0 new regression failures**;
- resource/cache/latency subset: original **73 tests, 71 passed, 2 failed**; fixed **80 tests, 78 passed, 2 failed**, with the same two pre-existing failure names;
- focused VPN/network/country-policy set: **21/21 passed**;
- lockfile portable-registry check: **352/352 resolved URLs approved**.

The remaining 14 full-suite failures are pre-existing in the supplied archive under this sandbox: several invoke the unavailable `tsx` package or unbuilt `.js` module paths, while others are source-pattern assertions already mismatched by the original archive. None is new in the fixed tree.

The `.git` directory was never operated on with Git commands. Pre-change and final manifests contain the same **28 files**; every `.git` file SHA-256, path, byte length, mode, and mtime is identical.
