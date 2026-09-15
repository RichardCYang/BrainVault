# Tor exit-directory streaming memory hardening

Date: 2026-09-15

## Scope

A resource-use audit covered recurring timers, observer lifecycles, long-lived maps/sets and bounded caches, network response materialization, database/background housekeeping, collaboration presence maintenance, and the existing performance-hardening paths.

The remaining reproducible avoidable memory hotspot was the Tor exit-address refresh in `src/lib/vpn-access-policy.ts`. The old path read an up-to-4 MiB response into a chunk array, concatenated it into a `Buffer`, decoded the full body into a UTF-8 string, and then materialized an additional full line array with `split(/\r?\n/)` before extracting `ExitAddress` records.

## Change

`src/lib/tor-exit-list.ts` now parses the Tor directory incrementally from `Response.body` with a streaming `TextDecoder`. It keeps only the current incomplete line plus the deduplicated public exit-address set. The parser:

- preserves the existing 4 MiB raw-byte limit,
- rejects an oversized declared `Content-Length` before consuming the body,
- counts actual streamed bytes and cancels an oversized chunked body,
- handles CRLF/LF boundaries and UTF-8 sequences split across chunks,
- processes a final unterminated line,
- preserves `ExitAddress`-only parsing, normalization, public-IP filtering, and deduplication.

The Tor request keeps the existing endpoint, timeout, headers, `redirect: "error"`, response-status handling, empty-list behavior, refresh cadence, stale-cache windows, and policy semantics.

## Reproduction benchmark

Run:

```bash
node scripts/reproduce-tor-exit-streaming-memory.mjs
```

The benchmark uses isolated child processes, a synthetic 4 MiB Tor-format input near the configured maximum, 16 KiB chunks, and five runs per mode. The script reports medians.

Observed in the verification environment:

| Metric | Legacy | Streaming | Reduction |
| --- | ---: | ---: | ---: |
| Peak RSS | 67,792,896 B | 42,426,368 B | 37.42% |
| Peak RSS above process baseline | 32,317,440 B | 6,946,816 B | 78.50% |
| Peak heap used | 17,209,040 B | 5,304,744 B | 69.17% |
| Peak heap above process baseline | 12,969,824 B | 1,065,520 B | 91.78% |

These numbers are a focused worst-case parser reproduction, not a claim that the whole BrainVault process will always use the same percentage less memory.

## Regression verification

Focused new resource tests:

```text
4 tests / 4 passed
```

They cover incremental decoding, split chunk boundaries, CRLF, final unterminated lines, duplicate/public-address semantics, chunked-body overflow cancellation, and declared-length early rejection.

The dependency-free full Node test suite was then run under identical conditions for the untouched baseline and the modified tree:

```text
Baseline: 1204 tests; 1187 passed; 17 failed
Modified: 1208 tests; 1191 passed; 17 failed
```

The modified tree adds exactly four passing tests. The 17 pre-existing failing test names were identical between the baseline and modified runs, so this change introduced no additional failure in that suite.

The project requires Node `^22.23.2 || ^24.18.1 || >=26.5.1`; the verification container provides Node 22.16.0. Dependency installation could not be completed in the sandbox, so the dependency-backed build/Vitest path was not represented as passing. The runtime security floor was deliberately not weakened to accommodate the sandbox. Source syntax checks for the changed TypeScript/Node files and the existing lockfile-registry check passed.

## Security invariants

No authentication, authorization, session, CSRF, CSP, SSRF, database, encryption, TLS, or VPN verdict logic was relaxed. The Tor endpoint still uses HTTPS with redirect rejection, and the parser retains public-IP validation. The optimization only changes how the bounded Tor response is consumed in memory.

## References

- Tor Project exit-address directory: https://check.torproject.org/exit-addresses
- Node.js `TextDecoder` documentation: https://nodejs.org/docs/latest-v22.x/api/util.html#class-utiltextdecoder
- WHATWG Encoding Standard (`TextDecoder` streaming semantics): https://encoding.spec.whatwg.org/
