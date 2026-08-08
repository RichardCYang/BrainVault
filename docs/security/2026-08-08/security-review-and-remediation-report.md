# BrainVault Security Review and Remediation Report

**Review date:** August 8, 2026  
**Input archive:** `BrainVault.zip`  
**Input archive SHA-256:** `d7aba79f45579816ef62e1bd30b1ef3a0a3c974de836dbf9ba4e4b44d1d9ac32`  
**Repository HEAD at intake:** `980236bd46f36be3e8ce3c6285d3a12ff86ea6b1`  
**Intake branch:** `main`  
**Intake commit:** `fix(auth): prevent bcrypt password truncation.`  
**Working-tree state at intake:** Modified; every pre-existing change was retained  
**Repository scope:** The complete uploaded project, including the retained `.git` directory and all reachable history  
**Assessment type:** Manual source review, source-directed exploit reproduction, remediation, dependency/advisory comparison, secret scanning, and dependency-free regression verification

## Executive Summary

No Critical-severity vulnerability and no new High-severity application exploit were reproduced. The delivered working tree contains remediations for two Medium findings:

- **BV-SEC-014 - bcrypt accepted passwords above its 72-byte effective-input boundary.** This remediation was already present in the uploaded working tree and was independently reverified across registration, login, password change, MFA reauthentication, passkey management, and demo seeding.
- **BV-SEC-015 - the patched Node.js security floor was enforced during npm installation but not during direct server startup.** An operator could run a prebuilt `dist/src/server.js` with `node` on a pre-floor runtime, bypassing `package.json` `engines` and `.npmrc` `engine-strict`.

The runtime-floor gap was reproduced without changing the project by creating a temporary package that declared an impossible Node.js range (`>=999.0.0`) with `engine-strict=true`; direct `node` execution still ran its entrypoint. BrainVault now performs a dependency-free, fail-closed runtime assertion in `src/server.ts` before TLS loading, database bootstrap, or listener startup. The guard implements the exact declared range `^22.23.2 || ^24.18.1 || >=26.5.1`, rejects malformed and prerelease version strings, and has a deterministic reproduction plus four regression tests.

The uploaded revision also contained the remediation for the previously documented deployment-dependent shared-cache disclosure, **BV-SEC-013**. That protection was re-reviewed and regression-tested. No bypass was reproduced in authentication/session state transitions, object authorization, SQL construction, Markdown/HTML handling, bookmark-preview SSRF controls, multipart uploads, backup ZIP processing, MFA/WebAuthn, or real-time collaboration controls.

The focused security command completed with **45 passing tests and 0 failures**. The complete dependency-free Node durability suite completed with **216 passing tests and 0 failures**. Data-loss, collaboration, lockfile-host, changed-file syntax, current-tree secret, reachable-history secret, and Git-object integrity checks passed.

The original `.git` directory is retained byte-for-byte from the uploaded archive and verified against a 28-file SHA-256 content manifest immediately before packaging. No Git history, refs, config, hooks, index, logs, or object files are changed by this remediation.

This assessment materially reduces demonstrated risk but is not proof that every vulnerability is absent. The isolated package mirror and runtime constraints prevented a fresh registry-backed audit, dependency installation, full TypeScript build with package types, Vitest/Supertest execution, live MariaDB integration, and browser-driven end-to-end testing. Those limits are recorded below rather than represented as successful checks.

## Finding Matrix

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| BV-SEC-015 | Medium, deployment-dependent | Direct server startup did not enforce the patched Node.js runtime floor | Remediated in this follow-up |
| BV-SEC-014 | Medium | Passwords above 72 UTF-8 bytes were silently reduced to the same bcrypt effective input | Remediation present at intake and reverified |
| BV-SEC-013 | High, deployment-dependent | Cookie-authenticated responses could be reused across users by a URI-keyed shared cache | Remediation present at intake and reverified |

Severity values reflect BrainVault's confidentiality, availability, and authentication-integrity impact and are not vendor CVSS scores.

## Scope and Review Method

The final reviewed tree contains 347 JavaScript, TypeScript, and SQL files comprising approximately 72,527 lines, plus configuration, documentation, lockfile data, static assets, and reachable Git history. Security-sensitive flows were traced across:

- Registration, login, password hashing and comparison, JWT verification, session cookies, logout, password changes, TOTP, WebAuthn, authentication-version revocation, login history, and account lockout
- Page, block, attachment, page-cover, sharing, archive, version-history, collaboration, search, and backup authorization boundaries
- Express middleware order, CORS, HTTPS enforcement, reverse-proxy trust, static-file routing, cache behavior, request limits, error handling, and access logging
- SQL construction, placeholder usage, dynamic statement fragments, transaction boundaries, row locks, optimistic edit versions, and idempotency receipts
- Multipart parsing, attachment signatures, active-content rejection, storage roots, download headers, admission limits, ZIP parsing, backup staging, manifest integrity, and restore recovery
- Markdown rendering, HTML sanitization, cached render output, DOM insertion, iframe restrictions, KaTeX, code highlighting, remote images, and custom data URLs
- Bookmark-preview SSRF controls, URL canonicalization, DNS resolution, IP-range rejection, redirects, absolute deadlines, encodings, and response-size limits
- WebSocket handshake parsing, exact origins, collaboration tickets, connection and queue limits, backpressure, Yjs validation, durable history, access rechecks, and session revocation
- Direct and relevant transitive dependency versions against selected current official advisories, the lockfile registry policy, and the configured Node.js runtime floor
- High-confidence secret patterns in the working tree and every unique blob reachable from Git refs

The method combined manual control-flow and data-flow review, route-to-authorization mapping, dangerous-sink inspection, SQL interpolation review, deterministic vulnerable-versus-fixed reproduction, source assertions, dependency-free tests, syntax verification, advisory comparison, secret scanning, and Git integrity checks. No exploit traffic was sent to any external system.

## Detailed Findings

### BV-SEC-014 - Bcrypt silently truncated accepted password input after 72 UTF-8 bytes

**Severity:** Medium  
**Weakness:** CWE-521 (Weak Password Requirements)  
**Affected pre-fix areas:** `src/routes/auth.routes.ts`, `src/routes/mfa.routes.ts`, `src/lib/auth.ts`, and `scripts/seed.ts`  
**Status in this review:** Remediation was present at intake and independently reverified.

#### Original Condition

The application accepted passwords up to 128 characters. It then passed those strings directly to `bcryptjs` for hashing or comparison.

Bcrypt's effective input is limited to 72 bytes. The locked `bcryptjs` 3.0.3 implementation retains that compatibility behavior and exposes `bcrypt.truncates(password)` so applications can detect an input that exceeds the boundary; hashing and comparison do not reject it automatically.

The previous validation was character-based rather than byte-based. Consequently:

- `"A".repeat(72) + "-ORIGINAL-SUFFIX"` and `"A".repeat(72) + "-CHANGED-SUFFIX"` are visibly different strings but have the same first 72 UTF-8 bytes.
- A 73-character ASCII password crosses the limit by one byte.
- Eighteen lock emoji occupy exactly 72 UTF-8 bytes, while nineteen occupy 76 bytes.
- Changing only a suffix beyond byte 72 does not rotate the effective bcrypt credential.

This did not create an unauthenticated universal bypass: an attacker still needed the effective 72-byte prefix. It nevertheless violated password-change integrity, silently discarded user-provided entropy, and made the user-visible credential differ from the credential actually protected by the hash.

#### Reproduction

Run:

```bash
npm run reproduce:bcrypt-password-boundary
```

The dependency-free reproduction models the documented and source-confirmed bcrypt input boundary and emits structured output. The observed result was:

| Check | Result |
| --- | --- |
| Original and changed passwords are different strings | `true` |
| Original password length | 88 UTF-8 bytes |
| Changed password length | 87 UTF-8 bytes |
| Effective first 72-byte inputs are equal | `true` |
| Patched policy accepts either long password | `false` |
| Patched policy accepts exactly 72 bytes | `true` |
| Patched policy accepts 73 bytes | `false` |

The exact locked package could not be installed in the validation container because the isolated mirror did not provide a required locked artifact. The implementation behavior was therefore verified against the official `bcryptjs` 3.0.3 source and API documentation, while the repository reproduction independently demonstrates the byte-boundary collision and the corrected acceptance policy.

#### Impact

A user who selected a password above 72 UTF-8 bytes could authenticate with any value having the same first 72 bytes. More importantly, a password change that altered only ignored bytes would appear successful while leaving the effective credential unchanged. This can defeat an intended credential rotation after suspected disclosure.

The issue is more likely to affect passphrases containing multi-byte Unicode because the byte limit can be reached with fewer than 72 visible characters.

#### Root Cause

The application treated its existing 128-character request cap as a cryptographic password limit. No common policy converted the password to UTF-8 bytes and checked bcrypt's algorithm-specific boundary, and the hashing/comparison helpers did not fail closed when called outside a validated route.

#### Remediation

- Added `src/lib/password-policy.ts` as the single source of truth for the 72-byte UTF-8 boundary and validation message.
- Added `passwordInputSchema(minLength)` in `src/utils/schemas.ts` and applied it to registration, login, password change, TOTP setup/removal, passkey registration, and passkey deletion.
- `hashPassword()` now rejects oversized input before hashing and also checks `bcrypt.truncates()`.
- `verifyPassword()` now returns `false` without invoking bcrypt for oversized input, protecting future callers even if route validation is omitted.
- Demo seeding rejects passwords above 72 UTF-8 bytes.
- User guidance and setup documentation now describe the byte boundary explicitly.
- Added `scripts/reproduce-bcrypt-password-boundary.mjs` and `tests/bcrypt-password-boundary.node.test.mjs`.
- Extended `scripts/verify-security-hardening.mjs` so the shared policy and every password-bearing boundary remain enforced.

No dependency or lockfile change was required.

#### Compatibility and Migration

A bcrypt hash does not reveal whether its original input contained ignored bytes after byte 72. Existing accounts that may use passwords above 72 UTF-8 bytes cannot be identified reliably from stored hashes alone.

Before deploying this change, administrators should arrange a password reset to a value of 72 UTF-8 bytes or fewer for any user known or suspected to use an unusually long password. After deployment, an oversized password is rejected instead of being silently reduced. Administrators should use the normal trusted account-recovery or administrative reset process rather than temporarily re-enabling truncation.

#### Regression Verification

`tests/bcrypt-password-boundary.node.test.mjs` verifies:

- Exact ASCII and Unicode byte boundaries
- Defense in depth inside the hashing and comparison helpers
- Shared schema use across authentication and MFA routes
- Seeding-policy coverage
- Vulnerable effective-input equality and patched rejection in the standalone reproduction

The test is included in `npm run verify:security`.

### BV-SEC-015 - Direct server startup did not enforce the patched Node.js floor

**Severity:** Medium, deployment-dependent  
**Weakness:** Runtime security policy enforced only by installation metadata  
**Affected pre-fix areas:** `package.json`, `.npmrc`, and `src/server.ts`  
**Status in this review:** Confirmed, reproduced, and remediated.

#### Original Condition

`package.json` correctly declared Node.js `^22.23.2 || ^24.18.1 || >=26.5.1`, and `.npmrc` set `engine-strict=true`. Those controls constrain npm installation, but the Node.js executable does not evaluate either file when an operator directly starts a JavaScript entrypoint. A deployment that copied a prebuilt `dist/` tree or retained previously installed dependencies could therefore run BrainVault below its declared patched runtime floor.

The validation environment itself demonstrated the practical gap: it ran Node.js 22.16.0 and successfully executed an npm script even though that version is below the project range. The standalone reproduction also creates an isolated temporary package with an intentionally impossible `engines.node` value and confirms that direct `node` execution still reaches the entrypoint.

#### Reproduction

Run:

```bash
npm run reproduce:runtime-security-floor
```

The dependency-free reproduction emits structured output and verifies both the retired metadata-only control and the remediated startup path:

| Check | Result |
| --- | --- |
| Direct `node` executes despite temporary `engines.node: ">=999.0.0"` | `true` |
| Temporary project also has `engine-strict=true` | `true` |
| Guard accepts Node.js 22.23.2, 24.18.1, and 26.5.1 | `true` |
| Guard rejects known pre-floor Node.js 22.16.0 | `true` |
| Guard executes before TLS load, database bootstrap, and listener startup | `true` |

#### Impact

The gap could leave a deployment running a Node.js release missing security fixes that the project explicitly required. The July 29, 2026 Node.js security releases fixed multiple High- and Medium-severity runtime issues across supported lines. Exploitability for BrainVault depends on the selected Node.js line, transport mode, runtime flags, and the vulnerable subsystem; no application-specific remote exploit of a Node.js CVE was demonstrated. The finding is therefore rated Medium and deployment-dependent rather than inheriting a vendor CVE's maximum severity.

#### Root Cause

The runtime version was represented only as package-manager metadata. The server entrypoint had no executable assertion tying the production process to the same security floor, so install-time policy and run-time policy could diverge.

#### Remediation

- Added `src/lib/runtime-security.ts` as a dependency-free implementation of the exact declared Node.js range.
- Added a fail-closed `assertSupportedNodeRuntime()` call to `src/server.ts` before TLS certificate loading, database bootstrap, recovery processing, collaboration setup, or network listening.
- Stable Node.js releases at or above 22.23.2, 24.18.1, and 26.5.1 are accepted; unsupported majors, lower patch levels, malformed values, and prerelease strings are rejected.
- Added `scripts/reproduce-runtime-security-floor.mjs` and `tests/runtime-security-floor.node.test.mjs`.
- Extended `scripts/verify-security-hardening.mjs` and `npm run verify:security` so the package range, runtime implementation, startup order, and reproduction remain aligned.

No dependency, lockfile, database migration, or Git metadata change was required.

#### Regression Verification

`tests/runtime-security-floor.node.test.mjs` contains four tests covering range boundaries, malformed/prerelease fail-closed behavior, server startup ordering, and the standalone reproduction. The tests pass under the dependency-free type-stripping runner even when the validation host itself is below the production floor because they test the pure guard with explicit version inputs and do not start the server.

### BV-SEC-013 - Authenticated responses could be reused across users by a shared cache

**Severity:** High, deployment-dependent  
**Weakness:** CWE-524 (Use of Cache Containing Sensitive Information), CWE-200 (Exposure of Sensitive Information)  
**Status in this review:** The uploaded revision already contained the remediation; this review reverified its placement and regression coverage.

#### Condition and Reproduction

Before its prior remediation, authenticated page-list and search responses did not consistently emit an origin-side private no-store policy. A URI-keyed reverse proxy or CDN rule with a default TTL could therefore store one cookie-authenticated user's response and reuse it for another user requesting the same URI.

Run:

```bash
npm run reproduce:authenticated-cache-isolation
```

The loopback reproduction uses a cookie-authenticated origin and a deliberately cache-enabled URI-keyed proxy. The retired vulnerable model returns Alice's response to Bob as a cache hit. The current policy produces two cache misses and returns only Bob's response to Bob.

#### Verified Remediation

- `requireAuth` applies `Cache-Control: private, no-store` before credential parsing, origin checks, JWT verification, database access, or downstream exits.
- Optional authenticated documentation disables static-file cache metadata and reapplies the same private no-store policy.
- Route-specific stricter directives remain intact.
- The deliberate page-cover exception remains private, requires immediate revalidation, and varies on `Cookie` and `Authorization`.
- Source-order assertions and the live HTTP reproduction remain included in `npm run verify:security`.

No regression or bypass was reproduced.

## Areas Where No Serious Vulnerability Was Reproduced

The following conclusions are scoped to the reviewed code and tests; they do not claim mathematical absence of all defects.

### Authentication, Sessions, and MFA

No reproducible JWT algorithm confusion, audience confusion, stale-session acceptance, cookie duplication ambiguity, login CSRF, password-change race, TOTP replay, MFA challenge reuse, passkey challenge reuse, passkey counter race, or post-credential-change session survival was found. API and collaboration JWT audiences are distinct, HS256 is fixed on sign and verify, authentication generations are checked against the user row, secure deployments use a `__Host-` cookie, duplicate cookie names fail closed, MFA challenges are single-use, and TOTP replay state is transactionally updated.

### Authorization and SQL

No unauthenticated route to note content, cross-account page/block mutation, version-history IDOR, attachment IDOR, or SQL injection was reproduced. Reviewed SQL values are parameterized; dynamic fragments are selected from fixed program-controlled structures or generated placeholder counts. Shared-page access is resolved through the page access layer, direct mutations are constrained by role and page state, and sensitive destructive operations repeat checks under transaction locks.

### Stored and DOM XSS

No stored-script execution path was reproduced from Markdown, imported backups, collaboration materialization, profile images, icons, covers, bookmark metadata, code highlighting, or structured blocks. Rendered note HTML is generated server-side and passed through an explicit `sanitize-html` policy; note-preview `innerHTML` sinks consume that sanitized cache. This conclusion depends on preserving the sanitize-on-write, import, and collaboration-materialization invariant and should be retested whenever the parser, sanitizer, renderer, or final DOM insertion context changes.

### SSRF

No bypass was reproduced against bookmark-preview URL validation. The implementation restricts schemes and ports, rejects credentials, resolves DNS before connection, blocks broad special-use IPv4 and IPv6 ranges, pins selected addresses into the HTTP client lookup, revalidates every redirect, enforces an absolute deadline, rejects compressed responses, and caps accepted bytes. Remote image and favicon URLs are normalized through the same public-target validation before being returned.

### Upload and Backup Processing

No attachment path traversal, active-content inline execution, temporary-upload preauthorization bypass, ZIP traversal, decompression bomb, duplicate-entry overwrite, manifest/file mismatch, or partial destructive restore was reproduced. Attachments are stored outside public, documentation, and Git paths; file names, MIME declarations, and signatures are checked; downloads use forced attachment and sandbox/nosniff headers; and request admission is bounded before processing.

The locked Multer version is 2.2.0, which is at the fixed boundary for the reviewed 2026 aborted-upload cleanup and deep nested-field resource-exhaustion advisories. Both attachment and backup multipart configurations additionally set `fieldNestingDepth: 1`, small part/header limits, and explicit request-size/concurrency controls.

### Collaboration and WebSockets

No WebSocket cross-origin acceptance, ticket-scope confusion, unlimited frame/message backlog, slow-consumer buffer growth, stale-auth collaboration survival, cross-instance silent overwrite, or state-equivalent Yjs amplification regression was reproduced. The implementation uses exact origins, short page-scoped tickets, authentication-generation and collaboration-epoch checks, handshake/frame validation, connection and pending-write ceilings, backpressure termination, durable-tip freshness fencing, and state-equivalence checks.

### Structured Metadata Boundary

Very deeply nested authenticated block metadata can eventually cause a synchronous `JSON.stringify` range error, but the route catches the exception and returns an error rather than terminating the process. Request-body and rate limits bound the input, and no cross-account or unauthenticated impact was reproduced. This was not classified as a serious vulnerability in the tested configuration. A future defense-in-depth improvement could impose explicit metadata depth and aggregate-key limits if the product begins accepting larger structured payloads.

## Dependency and Runtime Review

The lockfile pins direct runtime dependencies and uses approved portable registry hosts. Selected current official advisories relevant to exposed packages were compared with exact locked versions:

| Package | Locked version | Reviewed security baseline |
| --- | --- | --- |
| `bcryptjs` | 3.0.3 | Retains bcrypt's 72-byte behavior and exposes `truncates()`; application policy now rejects oversized input |
| `multer` | 2.2.0 | Fixed boundary for the reviewed 2026 aborted-upload cleanup and deep nested-field exhaustion advisories; application nesting depth is also limited |
| `express-rate-limit` | 8.5.2 | Above the 8.2.2 fix for IPv4-mapped IPv6 client-key collapse |
| `sanitize-html` | 2.17.5 | Above the reviewed 2026 sanitizer advisory fixes |
| `markdown-it` | 14.3.0 | Above the reviewed regular-expression and smart-quote complexity fixes |
| `linkify-it` | 5.0.2 | Includes both reviewed quadratic-scanning fixes through 5.0.2 |
| `picomatch` | 4.0.5 | Above the 4.0.4 extglob ReDoS fix |
| `postcss` | 8.5.25 | Above the 8.5.18 source-map path traversal fix and earlier 8.5.x file-read fixes |
| `@simplewebauthn/server` | 13.3.2 | Includes the reviewed 13.3.2 advisory fix |

No dependency change was required for the reviewed advisories. This comparison is not a substitute for a successful registry-backed audit of every transitive package.

The project requires Node.js `^22.23.2 || ^24.18.1 || >=26.5.1`. The validation container provided Node.js 22.16.0, below that project floor. The new server-entrypoint assertion now refuses to operate the application on that runtime even if installation metadata was bypassed. Dependency-free guard, reproduction, source-order, and regression checks ran successfully; production startup, CI installation, and the full build must still use a runtime satisfying the declared range.

## Secret and Repository Review

- No real `.env` file was present; only `.env.example` was included.
- No high-confidence PEM private key, AWS access key, GitHub token, npm token, OpenAI-style key, Slack token, Google API key, or Stripe live secret pattern was found in the final working tree.
- The same scan covered 1,779 unique blobs across 176 reachable Git revisions and found no match.
- `git fsck --full` passed before the original `.git` directory was restored for packaging.
- No generated `node_modules`, `dist`, attachment, upload, or runtime-secret directory is included in the release archive. The final working tree contains 425 non-Git files and no symbolic links.
- `.git` remains part of the deliverable exactly as requested. It is restored from the original input after commands that could refresh Git metadata, then compared file-by-file by size and SHA-256 against the original 28-file manifest.

## Verification Results

| Verification | Result |
| --- | --- |
| `npm run reproduce:bcrypt-password-boundary` | Different long passwords had equal effective 72-byte inputs; the fixed policy rejected both and accepted exactly 72 bytes |
| `npm run reproduce:authenticated-cache-isolation` | Retired model disclosed Alice to Bob; current model isolated both responses |
| `npm run reproduce:runtime-security-floor` | Direct Node.js execution bypassed impossible engine metadata; the fixed guard rejected 22.16.0 and ran before startup operations |
| `npm run verify:security` | PASS; hardening verifier plus 45 tests, 0 failures |
| `npm run test:durability` | PASS; 216 tests, 0 failures |
| `npm run verify:data-loss` | PASS |
| `npm run verify:collaboration` | PASS; source wiring, protocol checks, reproductions, and syntax checks for 306 files |
| `npm run lockfile:check` | PASS; 346 resolved URLs used approved registry hosts |
| Changed TypeScript and JavaScript syntax checks | PASS |
| High-confidence current-tree secret scan | PASS; no match in 425 non-Git files |
| High-confidence reachable-history secret scan | PASS; no match in 1,779 unique blobs across 176 revisions |
| `git fsck --full` | PASS |
| Final `.git` content-manifest comparison | PASS; 28 files, byte-for-byte content match |

## Validation Limitations

- `npm audit --package-lock-only` could not complete because the configured isolated registry returned HTTP 404 for the npm audit endpoint.
- A dependency installation attempt with the engine check explicitly bypassed could not complete because the isolated package mirror did not provide the locked `zod-3.25.76.tgz` artifact.
- The available Node.js 22.16.0 runtime is intentionally rejected by the new production startup guard. No supported Node.js runtime was available for a full server start.
- With no installed `node_modules`, a full TypeScript build, Vitest suite, Supertest route integration suite, and browser capture were unavailable.
- No live MariaDB service was available for production-parity transaction, migration, backup/restore, or authorization integration tests.
- No external CDN or reverse proxy was attacked. The cache condition is exercised by a loopback HTTP proxy implementing the affected URI-keyed default-TTL configuration.
- No independent dynamic application security scanner or third-party penetration test was available in the isolated environment.

These limits do not invalidate the source-confirmed bcrypt boundary, deterministic cache and runtime-floor reproductions, fail-closed runtime guard, or dependency-free regression results; they define what remains for deployment-parity assurance.

## Changed Files

This independent follow-up changed only the following project files; all pre-existing working-tree changes were retained:

- `src/lib/runtime-security.ts`
- `src/server.ts`
- `scripts/reproduce-runtime-security-floor.mjs`
- `scripts/verify-security-hardening.mjs`
- `tests/runtime-security-floor.node.test.mjs`
- `package.json`
- `docs/security/2026-08-08/security-review-and-remediation-report.md`

No database migration, dependency version, lockfile, Git history, or Git metadata change was required.

## Deployment Guidance

1. Before deployment, arrange a trusted password reset for any account known or suspected to use more than 72 UTF-8 bytes. Do not re-enable silent truncation as a migration shortcut.
2. Use a supported Node.js release satisfying `^22.23.2 || ^24.18.1 || >=26.5.1`. The server now refuses startup outside that range, but CI should still run `npm ci`, `npm audit`, `npm run build`, and the complete unit/integration suite on a supported runtime.
3. Deploy behind a reverse proxy or CDN rule that does not cache `/api/**` or authenticated `/docs/**`, and retain the origin's `Cache-Control` headers without replacement.
4. Keep `AUTH_ALLOW_BEARER_TOKENS=false`, `REGISTRATION_ENABLED=false` unless intentionally public, exact CORS/WebAuthn origins, exact trusted-proxy addresses, and HTTPS-only production cookies.
5. Use a dedicated non-public attachment volume with quotas and backups; never place it below `public/`, `docs/`, `.git/`, or the project root.
6. Re-run authentication, runtime-floor, HTML/XSS, cache, SSRF, backup, upload, and collaboration regression tests whenever the Node.js floor, server entrypoint, middleware order, password hashing, sanitizer/parser versions, reverse-proxy behavior, or response cache policy changes.

## External References Reviewed

- Official bcrypt.js 3.0.3 source and API documentation for the 72-byte compatibility boundary and `truncates()` helper
- OWASP Password Storage Cheat Sheet guidance for bcrypt's 72-byte input limit
- OWASP Authentication Cheat Sheet guidance against silent password truncation
- RFC 9111, *HTTP Caching*
- OWASP Web Security Testing Guide, *Testing for Browser Cache Weaknesses*
- Express 5 documentation for static response cache metadata
- Official npm `package.json` documentation for `engines` and `engine-strict` behavior
- Official Node.js July 29, 2026 security release information
- GitHub Security Advisories for the reviewed Multer, express-rate-limit, sanitize-html, markdown-it, linkify-it, picomatch, PostCSS, and SimpleWebAuthn issues
