# BrainVault Security Review and Remediation Report

**Review date:** August 8, 2026  
**Input archive:** `BrainVault.zip`  
**Input archive SHA-256:** `50895e50e2b04667cbde734e2a1d31c58f2cf41bbc78a277c434db4bd5c39252`  
**Repository HEAD at intake:** `5387852f3f3579f27a0d76cd657792562f26e15f`  
**Intake branch:** `main`  
**Intake commit:** `fix(security): harden attachment uploads and authenticated API caching.`  
**Repository scope:** The complete uploaded project, including the retained `.git` directory and reachable history  
**Assessment type:** Manual source review, source-directed exploit reproduction, remediation, dependency/advisory comparison, and dependency-free regression verification

## Executive Summary

No Critical-severity vulnerability was reproduced in the reviewed scope. One **High-impact, deployment-dependent information disclosure weakness** was confirmed and remediated:

- **Authenticated API responses did not have a complete cache-isolation policy at the authentication boundary.** Several sensitive routes set `Cache-Control: private, no-store` individually, but the cookie-authenticated page-list and search responses did not. HTTP does not give cookie-authenticated requests the shared-cache exception that applies to requests carrying `Authorization`. A reverse proxy or CDN configured to cache dynamic `200` responses by request URI could therefore store one user's response and reuse it for another user requesting the same URI. The default `/api/pages` request is especially exposed because its request URI is normally identical across users; `/api/search` can additionally contain note snippets.

A live loopback reproduction was built with a cookie-authenticated origin and a URI-keyed shared-cache proxy. In the vulnerable model, Alice's first request was a cache miss and Bob's request to the same endpoint was a cache hit returning Alice's response. With the patched authentication-boundary policy, both requests were cache misses at the shared cache and Bob received only Bob's response.

The fix applies `Cache-Control: private, no-store` in `requireAuth` before credential parsing, database access, or any downstream exit. This covers authenticated successes and errors without depending on every route author remembering a header. Optional authenticated documentation also disables static-file cache metadata and reapplies the same policy. The page-cover binary endpoint remains the only deliberate exception: it is private, immediately revalidated, and varies on `Cookie` and `Authorization`.

The focused security command completed with **37 passing tests and 0 failures**. The complete dependency-free Node durability suite completed with **208 passing tests and 0 failures**. The data-loss, collaboration, syntax, and lockfile verifiers passed. No high-confidence private key, cloud token, package token, AI-provider token, or messaging token was found in the current tree or reachable Git history.

The original `.git` directory is restored byte-for-byte from the uploaded archive immediately before packaging and is verified with a file-content manifest. No Git history, refs, config, hooks, index, logs, or object files are intentionally changed by this remediation.

This assessment materially reduces demonstrated risk but is not proof that every vulnerability is absent. Registry and dependency-install limitations prevented a fresh registry-backed audit, full TypeScript build with installed package types, Vitest suite, live MariaDB integration run, and browser-driven end-to-end exercise. Those limits are recorded below rather than treated as successful checks.

## Finding Matrix

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| BV-SEC-013 | High, deployment-dependent | Cookie-authenticated page-list and search responses could be reused across users by a URI-keyed shared cache | Remediated |

Severity reflects BrainVault's note-confidentiality impact and the prerequisite that a shared intermediary be configured to cache dynamic authenticated responses. It is not a vendor CVSS score.

## Scope and Review Method

The review covered 341 JavaScript, TypeScript, SQL, and related source files comprising approximately 72,101 lines, plus configuration, documentation, lockfile data, static assets, and reachable Git history. Security-sensitive flows were traced across:

- Registration, login, JWT verification, session cookies, logout, password changes, TOTP, WebAuthn, authentication-version revocation, login history, and account lockout
- Page, block, attachment, page-cover, sharing, archive, version-history, collaboration, search, and backup authorization boundaries
- Express middleware order, CORS, HTTPS enforcement, reverse-proxy trust, static-file routing, cache behavior, request limits, error handling, and access logging
- SQL construction, placeholder usage, dynamic statement fragments, transaction boundaries, row locks, optimistic edit versions, and idempotency receipts
- Multipart parsing, attachment signatures, active-content rejection, storage roots, download headers, admission limits, ZIP parsing, backup staging, manifest integrity, and restore recovery
- Markdown rendering, HTML sanitization, cached render output, DOM insertion, iframe restrictions, KaTeX, code highlighting, remote images, and custom data URLs
- Bookmark-preview SSRF controls, URL canonicalization, DNS resolution, IP-range rejection, redirects, absolute deadlines, encodings, and response-size limits
- WebSocket handshake parsing, exact origins, collaboration tickets, connection and queue limits, backpressure, Yjs validation, durable history, access rechecks, and session revocation
- Direct and relevant transitive dependency versions against selected current official advisories, the lockfile registry policy, and the configured Node.js runtime floor
- High-confidence secret patterns in the working tree and every reachable tracked revision

The method combined manual control-flow and data-flow review, route-to-authorization mapping, dangerous-sink inspection, SQL interpolation review, deterministic and live-loopback vulnerable-versus-fixed reproduction, source assertions, dependency-free tests, syntax verification, and official standards/advisory comparison. No exploit traffic was sent to any external system.

## Detailed Finding

### BV-SEC-013 - Authenticated responses could be reused across users by a shared cache

**Severity:** High, deployment-dependent  
**Weakness:** CWE-524 (Use of Cache Containing Sensitive Information), CWE-200 (Exposure of Sensitive Information)  
**Affected pre-fix areas:** `src/middleware/auth.ts`, `src/routes/page.routes.ts`, `src/routes/search.routes.ts`, and optional authenticated documentation wiring in `src/app.ts`

#### Original Condition

BrainVault correctly placed explicit private no-store headers on many high-risk responses, including page detail/render, version history, attachments, collaboration tickets, authentication state, and backup export/import. The policy was nevertheless route-local rather than enforced at the authentication boundary.

Two important authenticated `GET` responses had no explicit cache directive:

- `GET /api/pages` returns the current user's page summaries, owner/access information, tags, collaboration metadata, and page/block counts. Its default request URI is normally the same for every user.
- `GET /api/search` returns page matches and note-block snippets. Users who search the same term produce the same request URI while the response remains account-specific.

The built-in browser authenticates with an `HttpOnly` cookie rather than an `Authorization` header. Under HTTP caching rules, a shared cache is specifically restricted from reusing responses to requests with `Authorization` unless the response permits it. A request containing only `Cookie` does not receive that automatic rule. `Set-Cookie` also does not itself prohibit storage. Servers that need confidentiality must emit appropriate response cache directives.

A standards-compliant cache can store a response only when its storage rules allow it; `no-store` prohibits both private and shared storage, while `private` prohibits shared storage. In addition, operational reverse proxies and CDNs are often configured with explicit default TTLs that make otherwise unannotated `200` responses reusable by URI. Because the pre-fix page-list and search responses supplied neither directive, the application did not establish a reliable origin-side isolation boundary.

#### Reproduction

Run:

```bash
npm run reproduce:authenticated-cache-isolation
```

The script starts two loopback HTTP servers using only Node.js built-ins:

1. A cookie-authenticated origin that returns a different private note response for `session=alice` and `session=bob`.
2. A deliberately cache-enabled shared proxy keyed by HTTP method and request URI, representing a reverse-proxy or CDN rule with a default TTL for dynamic `200` responses.

It executes the same endpoint sequence against a vulnerable origin without an explicit policy and the fixed origin using BrainVault's actual `setPrivateNoStoreCacheControl()` helper.

Observed deterministic result:

| Model | Alice request | Bob request | Bob response owner | Cross-user disclosure |
| --- | --- | --- | --- | --- |
| Vulnerable | `MISS` | `HIT` | `alice` | Yes |
| Fixed | `MISS` | `MISS` | `bob` | No |

The reproduction is a controlled deployment model, not a claim that every CDN caches cookie-bearing responses by default. It proves that the origin's missing policy allowed a common cache configuration to convert an authenticated response into cross-user disclosure.

#### Impact

In an affected deployment, one authenticated user's page names, tags, owner/access metadata, page IDs, collection structure, and search snippets could be returned to another authenticated user. Search snippets can contain direct note content. Cached responses can also remain available after the originating user logs out because cache lifetime is separate from application session lifetime.

The attacker does not need to forge a token or bypass database authorization; the intermediary satisfies the second request without consulting BrainVault. This is why route-level authorization alone cannot mitigate the issue once a private response has been stored under a shared key.

#### Root Cause

Cache controls were implemented on selected route handlers rather than as an invariant of `requireAuth`. The current commit already protected many individual authenticated responses, but any omitted or newly added route could return account-specific data without a cache directive. Optional documentation used `express.static` with static cache metadata enabled by default, creating a second place where a downstream middleware could replace or supplement an authentication-layer header.

#### Remediation

- Added `src/lib/cache-control.ts` with a dependency-free, directly testable private no-store policy.
- `requireAuth` now invokes the policy before reading bearer tokens or cookies, before origin checks, before JWT verification, before database access, and before every success/error exit.
- This protects authenticated API responses and errors independent of individual route implementation.
- Optional `/docs` serving disables Express static `Cache-Control`, ETag, and Last-Modified generation and reapplies the private no-store policy in `setHeaders`.
- Existing route-specific stricter directives, such as backup `no-transform`, remain intact because handlers may deliberately replace the default.
- The page-cover endpoint retains `private, max-age=0, must-revalidate` plus `Vary: Cookie, Authorization`, allowing safe credential-partitioned conditional revalidation for unchanged image bytes.

#### Regression Verification

`tests/authenticated-response-cache-policy.node.test.mjs` verifies that:

- The executable policy produces exactly `Cache-Control: private, no-store`.
- A shared cache must reject storage under that policy.
- The middleware call appears before credential parsing and database access.
- Authenticated static documentation cannot enable its own cache metadata.
- The live HTTP reproduction shows disclosure in the retired model and isolation in the fixed model.

`scripts/verify-security-hardening.mjs` independently enforces the same source-order and static-handler invariants. The focused test is wired into `npm run verify:security`.

## Areas Where No Serious Vulnerability Was Reproduced

The following conclusions are scoped to the reviewed code and tests; they do not claim mathematical absence of all defects.

### Authentication and Session Boundaries

No reproducible JWT algorithm-confusion, audience-confusion, stale-session acceptance, cookie duplication ambiguity, login CSRF, password-change race, TOTP replay, passkey challenge reuse, or post-credential-change session survival was found. API and collaboration JWT audiences are distinct, HS256 is fixed on sign and verify, authentication generations are checked against the user row, secure deployments use a `__Host-` cookie, and duplicate cookie names fail closed.

### Authorization and SQL

No unauthenticated route to note content, cross-account page/block mutation, version-history IDOR, attachment IDOR, or SQL injection was reproduced. Reviewed SQL values are parameterized; dynamic fragments are selected from fixed program-controlled structures or generated placeholder counts. Shared-page access is resolved through the page access layer, direct mutations are constrained by role/page state, and sensitive destructive operations repeat checks under transaction locks.

### Stored and DOM XSS

No stored-script execution path was reproduced from Markdown, imported backups, collaboration materialization, profile images, icons, covers, bookmark metadata, code highlighting, or structured blocks. Rendered note HTML is generated server-side and passed through an explicit `sanitize-html` policy; the browser's note-preview `innerHTML` sinks consume that sanitized cache. Current locked sanitizer/Markdown/linkifier versions are above the reviewed 2026 advisory fixes. This conclusion depends on preserving the sanitize-on-write/import/materialization invariant and should be retested whenever the HTML parser, sanitizer, Markdown engine, or final DOM insertion context changes.

### SSRF

No bypass was reproduced against bookmark preview URL validation. The implementation restricts schemes and ports, rejects credentials, resolves DNS before connection, blocks broad special-use IPv4 and IPv6 ranges, pins the selected addresses into the HTTP client lookup, revalidates every redirect, enforces an absolute deadline, rejects compressed responses, and caps accepted bytes. Remote bookmark image/favicon URLs are normalized through the same public-target validation before being returned.

### Upload and Backup Processing

No attachment path traversal, active-content inline execution, temporary-upload preauthorization bypass, ZIP traversal, decompression bomb, duplicate-entry overwrite, manifest/file mismatch, or partial destructive restore was reproduced. Attachments are outside public/docs/Git storage, inspected by name/MIME/signature, served with forced download and sandbox/nosniff headers, and bounded before multipart intake. Backup import accepts BrainVault's bounded UTF-8 store-mode ZIP format, verifies local/central headers, CRC-32, SHA-256, sizes, entry relationships, and restore staging before replacement.

### Collaboration and WebSockets

No WebSocket cross-origin acceptance, ticket-scope confusion, unlimited frame/message backlog, slow-consumer buffer growth, stale-auth collaboration survival, cross-instance silent overwrite, or state-equivalent Yjs amplification regression was reproduced. The implementation uses exact origins, short page-scoped tickets, authentication generation and collaboration epoch checks, handshake/frame validation, connection and pending-write ceilings, backpressure termination, durable-tip freshness fencing, and state-equivalence checks.

## Dependency and Runtime Review

The lockfile pins the direct runtime dependencies and uses approved portable registry hosts. Selected current official advisories relevant to exposed packages were compared with the exact locked versions:

| Package | Locked version | Reviewed security baseline |
| --- | --- | --- |
| `multer` | 2.2.0 | Includes the fixes for the 2026 aborted-upload cleanup and deep nested-field resource-exhaustion advisories |
| `express-rate-limit` | 8.5.2 | Above the 8.2.2 fix for IPv4-mapped IPv6 client-key collapse |
| `sanitize-html` | 2.17.5 | Above the 2.17.3 and 2.17.4 fixes for the reviewed 2026 sanitizer advisories |
| `markdown-it` | 14.3.0 | Above the reviewed 14.1.1/14.2.0 regular-expression and smart-quote complexity fixes |
| `linkify-it` | 5.0.2 | Includes both reviewed quadratic-scanning fixes through 5.0.2 |
| `picomatch` | 4.0.5 | Above the 4.0.4 extglob ReDoS fix |
| `@simplewebauthn/server` | 13.3.2 | Includes the 13.3.2 low-severity advisory fix |

No dependency change was required for those reviewed advisories. This is not a substitute for a complete registry-backed audit of every transitive package.

The project requires Node.js `^22.23.2 || ^24.18.1 || >=26.5.1`, matching the July 29, 2026 security floors already documented by the project. The validation container provided Node.js 22.16.0, which is below the supported project floor. The dependency-free tests ran successfully, but production, CI, installation, and full build verification must use a supported patched runtime. At review time, the official Node release page listed Node.js 24.19.0 as the latest LTS and 26.7.0 as the latest Current release.

## Secret and Repository Review

- No `.env` file was present; only `.env.example` was included.
- No high-confidence PEM private key, AWS access key, GitHub token, npm token, OpenAI-style key, Slack token, or Google API key pattern was found in the final working tree.
- The same high-confidence scan across all reachable tracked revisions returned no match.
- No user attachment directory or generated `node_modules` directory is included in the final package.
- `.git` remains part of the deliverable exactly as requested. It is restored from the original archive after all commands that might update the Git index stat cache, then compared file-by-file by SHA-256 before packaging.

## Verification Results

| Verification | Result |
| --- | --- |
| `npm run reproduce:authenticated-cache-isolation` | Vulnerable model disclosed Alice to Bob; fixed model isolated both responses |
| `npm run verify:security` | PASS; hardening verifier plus 37 tests, 0 failures |
| `npm run test:durability` | PASS; 208 tests, 0 failures |
| `npm run verify:data-loss` | PASS |
| `npm run verify:collaboration` | PASS; source wiring, protocol checks, reproductions, and syntax for 300 files |
| `npm run lockfile:check` | PASS; 346 resolved URLs on approved registry hosts |
| High-confidence current-tree secret scan | PASS; no match |
| High-confidence reachable-history secret scan | PASS; no match |
| Final `.git` content-manifest comparison | Required before archive release; recorded in the delivery summary |

## Validation Limitations

- `npm audit --package-lock-only` could not complete because the configured isolated registry returned an HTTP 404 for the audit endpoint.
- `npm ci --ignore-scripts` could not complete because the isolated package mirror did not provide the locked `zod-3.25.76.tgz` artifact.
- With no installed `node_modules`, a full TypeScript build, Vitest suite, Supertest route integration suite, and browser capture were unavailable.
- No live MariaDB service was available for production-parity transaction, migration, backup/restore, or authorization integration tests.
- No external CDN or reverse proxy was attacked. The cache issue was reproduced with an actual loopback HTTP proxy implementing the affected URI-keyed default-TTL configuration.
- No independent dynamic application security scanner or third-party penetration test was available in the isolated environment.

These limits do not invalidate the reproduced cache disclosure or the dependency-free regression results; they define what remains for deployment-parity assurance.

## Changed Files

- `src/lib/cache-control.ts`
- `src/middleware/auth.ts`
- `src/app.ts`
- `scripts/reproduce-authenticated-cache-isolation.mjs`
- `scripts/verify-security-hardening.mjs`
- `tests/authenticated-response-cache-policy.node.test.mjs`
- `package.json`
- `docs/security/2026-07-30/security.md`
- `docs/security/2026-08-08/security-review-and-remediation-report.md`

No database migration, lockfile dependency version, public asset, or Git-history change was required.

## Deployment Guidance

1. Deploy behind a reverse proxy/CDN rule that does not cache `/api/**` or `/docs/**`; retain origin `Cache-Control` headers without replacement.
2. Use Node.js 24.19.0 LTS or another currently supported release satisfying the project's engine range, then run `npm ci`, `npm audit`, `npm run build`, and the complete test suite in CI.
3. Keep `AUTH_ALLOW_BEARER_TOKENS=false`, `REGISTRATION_ENABLED=false` unless intentionally public, exact `CORS_ORIGIN`/WebAuthn origins, exact trusted proxy addresses, and HTTPS-only production cookies.
4. Use a dedicated non-public attachment volume with quotas and backups; never place it below `public/`, `docs/`, `.git/`, or the project root.
5. Re-run HTML/XSS, cache, SSRF, backup, and collaboration regression tests whenever route middleware order, sanitizer/parser versions, reverse-proxy behavior, or response cache policy changes.

## External References Reviewed

- RFC 9111, *HTTP Caching*, especially Sections 3, 3.5, 4.1, 5.2.2.5, 5.2.2.7, and 7.3
- OWASP Web Security Testing Guide, *Testing for Browser Cache Weaknesses*
- Express 5 documentation for `express.static` cache-control, ETag, Last-Modified, and `setHeaders` behavior
- Official Node.js July 29, 2026 security releases and the August 2026 release index
- GitHub Security Advisories for the reviewed Multer, express-rate-limit, sanitize-html, markdown-it, linkify-it, picomatch, and SimpleWebAuthn issues
