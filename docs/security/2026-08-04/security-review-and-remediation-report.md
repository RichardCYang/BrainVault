# BrainVault Security Review and Remediation Report

**Review date:** August 4, 2026  
**Input archive:** `BrainVault.zip`  
**Input archive SHA-256:** `b2fb88b2002a90004686d870e778f0150ff6bc773ff832f55ffd9cfc31216903`  
**Repository HEAD at intake:** `a20c71ed4ec70c57643140bf71f590148f8dadb2`  
**Intake commit:** `fix(security): harden dependencies and collaboration module loading.`  
**Repository scope:** The complete uploaded project, including the retained `.git` directory and reachable history

## Executive Summary

BrainVault received a security-focused source review, targeted exploit reproduction, dependency-advisory verification, remediation, and regression testing.

No Critical-severity vulnerability was reproduced in the reviewed scope. Three additional security weaknesses were confirmed and remediated during this pass:

1. **High — synchronous Highlight.js algorithmic denial of service.** User-controlled C/C++ code could trigger quadratic regular-expression work in both server-side rendering and browser hydration. A 20,000-character reproduction blocked the pre-fix server renderer for approximately 1.15 seconds in the audit environment.
2. **Medium — authenticated backup import/export resource exhaustion.** The previous backup limits allowed very large archives and manifests, broad ZIP directory structures, and repeated or concurrent restore work. A single 32 MiB manifest caused approximately 96 MiB of resident-memory growth and about 475 ms of synchronous work in an isolated pre-fix reproduction.
3. **High — deployment runtime range included security-vulnerable Node.js releases.** The previous `>=22.13.0` engine declaration allowed releases older than the July 29, 2026 Node.js security updates. The supported ranges now begin at the patched releases for each accepted major line, and installation fails closed on older runtimes.

The uploaded repository already contained two earlier security remediations. They were independently rechecked rather than assumed correct:

- **High — `ip-address` trust-boundary classification vulnerabilities:** remediated at intake with `ip-address@10.3.1`; lockfile and regression checks passed.
- **Medium — third-party collaboration runtime execution:** remediated at intake by serving lockfile-controlled Yjs modules from the BrainVault origin; CSP/import-map invariants passed.

The final dependency-free Node test suite completed with **93 passing tests and 0 failures**. The focused security-remediation suite completed with **11 passing tests and 0 failures**. All changed JavaScript and TypeScript files passed syntax checks, the security verifier passed, and all 346 lockfile-resolved package URLs used approved registry hosts.

This review materially reduces the demonstrated risks but is not a proof that every possible vulnerability is absent. Deployment topology, database behavior, reverse-proxy configuration, and browser integration must still be validated in the real production environment.

## Finding Matrix

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| BV-SEC-001 | High | Vulnerable transitive `ip-address` classification behavior | Remediated at intake; independently validated |
| BV-SEC-002 | Medium | Remote third-party Yjs runtime execution | Remediated at intake; independently validated |
| BV-SEC-003 | High | Highlight.js quadratic CPU denial of service | Newly reproduced and remediated |
| BV-SEC-004 | Medium | Backup import/export resource exhaustion | Newly reproduced and remediated |
| BV-SEC-005 | High | Node.js engine range admitted pre-security-fix runtimes | Newly remediated |

Severity reflects the BrainVault deployment context and exploit prerequisites, not a formal vendor CVSS score.

## Scope and Review Method

The review traced security-sensitive behavior across:

- Registration, login, session cookies, JWT validation, logout, session revocation, TOTP, and WebAuthn
- Page, block, attachment, share, version, and collaboration object authorization
- Bookmark preview URL validation, DNS resolution, redirect handling, and response bounds
- Attachment upload, signature validation, private storage, and download response policy
- Complete-data backup export/import, ZIP parsing, manifest validation, attachment staging, destructive restore, and recovery journals
- Markdown rendering, sanitization, cached HTML, KaTeX, syntax highlighting, and browser DOM insertion
- WebSocket origin checks, collaboration tickets, message limits, backpressure, and durable materialization
- SQL construction, filesystem paths, process execution, cryptographic APIs, and security-sensitive randomness
- Content Security Policy and browser supply-chain boundaries
- Locked dependency versions and public advisories relevant to those versions
- Obvious private-key and common cloud/API token patterns in the working tree and reachable Git object history

The method combined manual source tracing, targeted static searches, adversarial input construction, isolated timing/memory probes, dependency-lock verification, source-invariant verifiers, syntax validation, and dependency-free regression tests.

## Detailed Findings

### BV-SEC-003 — Highlight.js Quadratic CPU Denial of Service

**Severity:** High  
**Status:** Remediated

#### Original condition

BrainVault vendors Highlight.js `11.0.1` and uses it synchronously in two attacker-influenced paths:

- Server rendering in `src/lib/code-highlighting.ts`
- Browser rendering and hydration in `public/code-highlighting.js`

The upstream Highlight.js issue for the C/C++/Arduino `FUNCTION_DECLARATION` grammar documents a nested-quantifier pattern with quadratic backtracking. Its proof of concept is repeated words separated by spaces, such as `"a ".repeat(n)`. The issue also reproduces against Highlight.js `11.11.1`, so merely upgrading from the vendored `11.0.1` to the latest affected line would not provide a reliable fix.

Because server-side highlighting runs synchronously, a crafted note can monopolize the Node.js event loop. Persisted content also makes the cost repeatable when a page is rendered, restored, or collaboration state is materialized. Browser hydration can similarly freeze a client tab.

#### Reproduction

The upstream payload was run against the pristine uploaded bundle in an isolated Node.js process. Representative measurements were:

| C source length | Pre-fix server highlighting time |
| ---: | ---: |
| 8,000 characters | approximately 197 ms |
| 16,000 characters | approximately 752 ms |
| 20,000 characters | approximately 1,146 ms |

Doubling the input produced approximately four times the work, matching the expected quadratic trend. Absolute timings are machine-dependent, but the growth pattern is the relevant security property.

#### Fix

Server-side rendering now:

- Limits untrusted syntax-highlighted source to 2,000 UTF-16 code units.
- Executes grammar evaluation inside a reusable `node:vm` context with a 25 ms deadline.
- Falls back to complete HTML-escaped plaintext when the source is too long, the grammar is unavailable, Highlight.js throws, or the deadline is exceeded.
- Preserves the full original source rather than truncating note data.

Browser rendering now:

- Uses the same 2,000-unit per-block ceiling.
- Uses `textContent` for the safe plaintext fallback.
- Caps automatic hydration to 20 blocks and 8,000 aggregate source units per hydration pass.
- Leaves over-budget blocks readable as plaintext instead of executing the grammar.

#### Verification

`tests/code-highlighting-resource-limits.node.test.mjs` reproduces the adversarial input, asserts a fast fallback, confirms complete HTML escaping, and locks the server/browser budgets together. On the remediated tree, the same 20,000-character payload returned escaped plaintext in approximately 0.17 ms in an isolated rerun.

The 25 ms VM deadline is defense in depth for inputs below the length ceiling. JavaScript VM timeouts are not a general sandbox boundary; here they are used only to bound synchronous grammar execution from a locally bundled library.

### BV-SEC-004 — Authenticated Backup Import/Export Resource Exhaustion

**Severity:** Medium  
**Status:** Remediated

#### Original condition

Complete-data import required authentication, but one account could still impose disproportionate process, disk, and database load. The previous defaults and parser behavior allowed:

- Backup uploads and aggregate uncompressed contents up to 4,096 MiB by default.
- A manifest up to 128 MiB to be allocated, converted to a string, parsed as JSON, and validated.
- ZIP central directories up to 256 MiB and up to 1,000,000 entries at the generic parser layer.
- Repeated restore requests without a restore-specific rate limit.
- Multiple simultaneous restores from the same principal or across the process.
- Export manifest serialization into one aggregate JSON string before proving that the manifest fit the import limit.
- Database snapshot work before all inexpensive archive-structure checks completed.

This was not a ZIP-slip or decompression-bomb bypass; the existing archive integrity controls were substantial. The weakness was resource admission: a validly structured but intentionally large request could consume memory, CPU, disk, and destructive-restore preparation capacity.

#### Reproduction

An isolated pre-fix probe used a ZIP containing a 32 MiB manifest. The old path produced approximately 96 MiB of resident-memory growth and about 475 ms of synchronous allocation/string/parse work. The configured manifest ceiling was four times larger. Measurements vary by garbage-collector state and platform, but they demonstrated significant amplification before semantic validation.

Against the new 16 MiB manifest ceiling, the same oversized entry is rejected from ZIP metadata before its body is allocated for parsing. In an isolated post-fix probe, rejection occurred in approximately 4 ms with less than 0.4 MiB of measured resident-memory growth.

#### Fix

Request admission and upload handling now:

- Default `DATA_TRANSFER_MAX_SIZE_MB`: 1,024 MiB; schema maximum: 16,384 MiB.
- Default `DATA_TRANSFER_MAX_MANIFEST_SIZE_MB`: 16 MiB; schema maximum: 64 MiB.
- Default import allowance: 3 requests per authenticated principal per hour.
- One active import per principal.
- Default maximum of 2 active imports per application process.
- `Content-Length` preflight before multipart parsing, with only 1 MiB allowed for multipart overhead.
- Multer limits for file size, file count, fields, parts, field-name size, header pairs, and nesting depth.
- Temporary upload deletion in the route's `finally` path.

Archive and manifest validation now:

- Applies a backup-specific maximum of 5,001 ZIP entries: one manifest plus at most 5,000 attachments.
- Applies a backup-specific 4 MiB central-directory ceiling.
- Rejects a manifest whose uncompressed ZIP size exceeds the configured manifest limit before allocating it.
- Rejects local/central ZIP filename-length mismatches before reading an attacker-selected local-name length.
- Limits manifest collections to 20,000 pages, 50,000 blocks, 20,000 tags, 100,000 page-tag relationships, 20,000 shares, and 5,000 attachments.
- Validates archive structure, manifest relations, allowed entries, and foreign identifier conflicts before taking the current workspace restore snapshot.

Export now:

- Applies the same collection limits.
- Bounds cumulative staged attachment bytes before and after file inspection.
- Measures the exact UTF-8 JSON size without first constructing one aggregate manifest string, stopping as soon as the configured limit is exceeded.
- Verifies aggregate uncompressed content and calculated final archive size before streaming.
- Preserves the existing attachment-integrity error semantics; resource-limit errors are no longer converted into misleading missing-attachment responses.

#### Operational limitation

The concurrency gate is intentionally process-local. A multi-process or multi-host deployment must enforce a shared restore concurrency policy at the reverse proxy, job queue, or distributed coordination layer. Per-principal rate limiting may also need an external store to be globally consistent across replicas.

### BV-SEC-005 — Vulnerable Node.js Runtime Floor

**Severity:** High  
**Status:** Remediated

#### Original condition

`package.json` previously declared Node.js `>=22.13.0`. That admitted Node.js versions predating the July 29, 2026 security releases. The vendor releases for Node.js 22.23.2, 24.18.1, and 26.5.1 include multiple High-severity fixes, including HTTP/2 session memory accounting, HTTP/2 reset-stream lifetime handling, and permission-model path handling.

Application dependency pinning cannot remediate vulnerabilities in the runtime that accepts network traffic. A production deployment satisfying the old engine declaration could therefore remain exposed while appearing supported by the project.

#### Fix

- `package.json` and the lockfile root now require `^22.23.2 || ^24.18.1 || >=26.5.1`.
- `.npmrc` now sets `engine-strict=true`, causing npm installation to fail on older runtimes instead of emitting only a warning.
- Setup, configuration, collaboration, and security documentation now state the patched runtime floor.
- The source verifier and focused regression suite assert the exact engine range and strict-install setting.

The audit container supplied Node.js `22.16.0`. Dependency-free source tests could run there, but the remediated package intentionally rejects that version for installation or deployment.

## Independent Validation of Existing Intake Remediations

### BV-SEC-001 — `ip-address` Classification Vulnerabilities

**Severity:** High  
**Status:** Remediated at intake; independently validated

The lockfile selects `ip-address@10.3.1` through an npm override. That version is outside the affected ranges of the reviewed 2026 leading-zero IPv4, attacker-controlled CIDR suffix, and IPv4-mapped/NAT64 classification advisories.

The focused test also preserves the leading-zero reproduction boundary: Node.js canonicalizes `http://012.0.0.1/` to `10.0.0.1`. The regression fails if a vulnerable `ip-address` version re-enters the lockfile.

BrainVault's bookmark-preview SSRF defense does not rely on `ip-address`. It was separately traced and retains normalized protocol/port checks, complete DNS-answer validation, connection address pinning, redirect revalidation, absolute deadlines, byte limits, content-type restrictions, and unsafe-address rejection. No bookmark SSRF bypass was reproduced in the supplied implementation and tests.

### BV-SEC-002 — Third-Party Yjs Runtime Execution

**Severity:** Medium  
**Status:** Remediated at intake; independently validated

The collaboration client imports Yjs from same-origin routes backed by the lockfile-controlled `yjs`, `lib0`, and `isomorphic.js` packages. The reviewed CSP no longer permits the former remote Yjs module URL. A compact import map is authorized by an exact SHA-256 CSP hash, and the regression suite verifies that the import map, CSP hash, server routes, and lockfile-selected module versions remain aligned.

No remote Yjs reference or collaboration CSP regression was found.

## Other High-Risk Areas Reviewed Without a Reproduced Exploit

### Authentication and sessions

JWT verification fixes the expected algorithm, issuer, and audience. Authorization consumes verified claims rather than decoded untrusted claims. Session cookies are `HttpOnly`, `SameSite=Strict`, and secure in HTTPS mode. Session invalidation is tied to authentication versioning. Sensitive authentication state changes enforce browser-origin and JSON expectations. Login and MFA abuse controls, atomic MFA attempt reservation, TOTP replay prevention, and WebAuthn challenge/origin/RP/user-verification checks are covered by source assertions and regression tests.

### Object-level authorization

Page, block, attachment, sharing, version, and collaboration operations trace ownership or editor permission before returning or mutating protected resources. Unauthorized object access is generally normalized to a non-enumerating not-found result. No reproducible insecure direct object reference was identified in the reviewed routes.

### Server-side URL fetching

The bookmark preview path validates normalized protocols, forbids credentials and unapproved ports, resolves and validates all destination addresses, rejects mixed safe/unsafe answer sets, pins a validated address into the outbound connection, repeats validation after redirects, disables content encoding, and enforces absolute time and response-size limits. No DNS-rebinding, redirect, alternate IPv4 spelling, mapped IPv6, or oversized-response bypass was reproduced.

### Attachments

Attachments are stored outside the public static root under generated names. Upload count, nesting, and size are bounded; signatures are checked in addition to metadata. Downloads use restrictive cache/content-sniffing headers, and potentially active content is forced into a constrained response policy. No path traversal or arbitrary-file retrieval path was reproduced.

### Rendering and DOM sinks

Markdown source HTML is sanitized before storage/use. Sanitizer policy restricts tags, attributes, URL schemes, and embedded content. Links receive opener protections, images use a no-referrer policy, KaTeX trust is disabled, and imported content is rerendered instead of trusting imported cached HTML. Reviewed `innerHTML` assignments were supplied by fixed catalogs, server-sanitized HTML, or Highlight.js output with the new resource gate and safe fallback. No stored or reflected XSS payload was reproduced.

### Collaboration and WebSockets

WebSocket upgrades enforce the configured origin. Collaboration uses short-lived purpose-specific tickets, rechecks access at connection and persistence boundaries, and limits frames, document state, connection allocation, inbound queues, outbound buffering, and durable materialization. No unauthenticated room join, cross-page ticket reuse, or obvious limit bypass was reproduced.

### Secrets and history

The working tree and reachable Git blobs were scanned for obvious private keys and common hosted-service credential and token formats. No likely credential was detected by those pattern checks. Pattern matching cannot prove the absence of every proprietary, low-entropy, or context-dependent secret.

## Locked Dependency Advisory Review

The following security-relevant locked versions were checked against the reviewed public advisories:

| Package | Locked version | Review result |
| --- | ---: | --- |
| `ip-address` | 10.3.1 | Outside the reviewed affected ranges |
| `express-rate-limit` | 8.5.2 | Newer than the reviewed 8.2.2 fix level |
| `multer` | 2.2.0 | Includes the reviewed aborted-upload cleanup and nested-field DoS fixes |
| `sanitize-html` | 2.17.5 | At the reviewed fix version |
| `markdown-it` | 14.3.0 | Newer than the reviewed 14.2.0 fix version |
| `linkify-it` | 5.0.2 | At the reviewed fix version for both relevant advisories |
| `postcss` | 8.5.25 | Newer than the reviewed 8.5.18/8.5.19 fix levels |
| `qs` | 6.15.3 | Newer than the reviewed 6.14.2 fix version |

The vendored Highlight.js bundle remains version `11.0.1`, but the upstream quadratic issue is also reported against `11.11.1`. BrainVault therefore applies application-level execution limits and plaintext fallback rather than claiming that an unaffected upstream release was available during this review.

`npm audit` could not be completed in the audit container, so this table is a targeted advisory review rather than a complete registry-generated audit result.

## Reproducibility and Validation Results

### Focused security suite

Command:

```bash
node --experimental-strip-types --test \
  tests/security-remediation.node.test.mjs \
  tests/code-highlighting-resource-limits.node.test.mjs \
  tests/data-transfer-resource-limits.node.test.mjs
```

Result: **11 passed, 0 failed**.

The focused suite covers the patched `ip-address` lock, Node.js security floor, same-origin collaboration runtime/CSP hash, advisory hostname canonicalization, Highlight.js long-input fallback and escaping, aligned server/browser highlighting budgets, exact bounded JSON byte measurement, import concurrency admission, ZIP entry/central-directory ceilings, local-header mismatch rejection, and early backup admission ordering.

### Full dependency-free suite

Command:

```bash
node --experimental-strip-types --test tests/*.node.test.mjs
```

Result: **93 passed, 0 failed**.

### Source and lock checks

- `scripts/verify-security-hardening.mjs`: passed.
- Syntax checks for every changed `.js`, `.mjs`, and `.ts` source/test file: passed.
- `scripts/lockfile-registry.mjs`: passed; 346 resolved URLs used approved portable registry hosts.
- Exact source comparison against the pristine extraction: only the files listed below differ.
- `.git` is restored from and byte-compared with the pristine extraction immediately before packaging.

### Environment limitations

The analysis environment could not complete `npm ci` because its configured package mirror did not provide every package in the supplied lockfile, while direct public-registry DNS was unavailable. Consequently, the following could not be claimed as completed:

- `npm audit`
- Full TypeScript compilation through the installed project toolchain
- Vitest unit/integration suites that require installed dependencies
- MariaDB-backed integration tests
- Browser-driven end-to-end collaboration and rendering tests

These are environment limitations, not passing results. The direct Node regression suite and syntax checks are complementary and do not replace those deployment tests.

## Files Changed in This Remediation Pass

- `.env.example`
- `.npmrc`
- `README.md`
- `docs/security/2026-08-04/security-review-and-remediation-report.md`
- `docs/collaboration/2026-07-29/collaboration.md`
- `docs/configuration/2026-07-28/configuration.md`
- `docs/getting-started/2026-07-27/getting-started.md`
- `docs/security/2026-07-30/security.md`
- `package-lock.json`
- `package.json`
- `public/code-highlighting.js`
- `scripts/verify-security-hardening.mjs`
- `src/config/env.ts`
- `src/lib/code-highlighting.ts`
- `src/lib/data-import-admission.ts`
- `src/lib/data-transfer-limits.ts`
- `src/lib/data-transfer.ts`
- `src/lib/zip.ts`
- `src/middleware/data-rate-limit.ts`
- `src/routes/data.routes.ts`
- `tests/code-highlighting-resource-limits.node.test.mjs`
- `tests/code-highlighting.test.ts`
- `tests/data-transfer-resource-limits.node.test.mjs`
- `tests/security-remediation.node.test.mjs`

No separate raw audit-log file was added.

## Deployment Follow-Up

Use a patched supported runtime, then run the complete project checks from a network that can access the lockfile registry and an integration environment matching the production MariaDB major version:

```bash
node --version
npm ci
npm audit --omit=dev
npm run check
npm run verify:security
npm run verify:collaboration
npm run verify:data-loss
```

Before production release, also verify:

- Reverse-proxy trust boundaries, forwarded headers, HTTPS redirects, and the exact `PUBLIC_ORIGIN`/`CORS_ORIGIN` values
- Secure cookie behavior and WebSocket upgrades through the real proxy/CDN path
- Shared rate-limit and restore-concurrency storage when more than one application process or host is used
- Disk quotas for upload, data-transfer temporary, backup, and attachment directories
- Database account privileges, transaction behavior, lock timeouts, and restore recovery under failure injection
- Backup retention, encryption, access control, and recovery drills
- Browser rendering and collaboration behavior with the production CSP and static-asset cache

## Repository Preservation

The supplied `.git` directory is retained in the remediated archive. Before packaging, it is restored byte-for-byte from the pristine extraction and verified by relative path, file type, size, and SHA-256 content manifest. The `.git` directory itself is not deleted or replaced. No Git command is run after that restoration step.

The original working-tree line-ending state is preserved for modified text files. No `node_modules`, temporary upload, benchmark output, or standalone audit-log file is included in the final archive.

## Conclusion

The review confirmed and fixed three additional security weaknesses, independently validated the two security remediations already present at intake, and found no reproducible Critical-severity exploit in the reviewed source paths. The most material code-level risk was the synchronous syntax-highlighting denial of service; it is now bounded on both server and browser paths without truncating stored note content. Backup restoration now fails earlier and admits substantially less unbounded work, and deployment tooling now rejects Node.js releases older than the July 29, 2026 security fixes.
