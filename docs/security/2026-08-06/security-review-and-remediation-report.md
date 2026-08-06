# BrainVault Security Review and Remediation Report

**Review date:** August 6, 2026  
**Input archive:** `BrainVault.zip`  
**Input archive SHA-256:** `6640d7b48590196365681dd44801ff554aba036e6af8a7643444ed7fa32f8d50`  
**Repository HEAD at intake:** `f0e008f3ae2b35cd18255397bc05b9d247893dbc`  
**Intake commit:** `fix(page-cover): remove gap between header and cover image.`  
**Repository scope:** The complete uploaded project, including the retained `.git` directory and reachable history  
**Assessment type:** Source review, source-directed exploit reproduction, remediation, and dependency-free regression verification

## Executive Summary

No Critical-severity vulnerability was reproduced in the reviewed scope. One High-severity and two Medium-severity weaknesses were confirmed and remediated:

1. **High — MFA credential changes did not establish a new authentication boundary.** Adding, replacing, or deleting a TOTP credential or passkey did not increment `auth_version`, revoke other sessions, terminate collaboration sockets, clear pending authentication state, or issue a replacement cookie. A stolen session therefore remained valid after a factor change. The split passkey/TOTP flows also allowed an already-authenticated request to cross a concurrent password or factor-change boundary and commit stale credential state.
2. **Medium — current-password checks lacked an account-scoped failure limit.** Password change, TOTP setup/removal, and passkey setup/removal were reachable through authenticated sessions but relied only on the process-wide IP-oriented request limit. A stolen session could therefore be used as a distributed online current-password oracle without consuming the login endpoint's account bucket.
3. **Medium — the global request limiter ran after body parsing.** Requests that had already exceeded the global rate limit could still force JSON or URL-encoded parsing before receiving HTTP 429, allowing repeated parsing of bodies up to the configured 5 MiB JSON limit.

The remediation makes every MFA binding or invalidation an atomic credential-boundary transaction: it locks the user row, rechecks the request's `auth_version`, performs the factor mutation, increments `auth_version`, invalidates pending MFA and WebAuthn state, disconnects process-local collaboration sockets, and issues a replacement session cookie. Password change and logout now use the same stale-request fence and also remove unfinished TOTP enrollment state. Current-password operations share an account-keyed failure limiter, and the global limiter executes before request-body parsers.

The final dependency-free Node suite completed with **186 passing tests and 0 failures**. The focused security suite completed with **17 passing tests and 0 failures**. The data-loss, collaboration, syntax, and lockfile verifiers also passed. The original `.git` directory was retained and restored byte-for-byte before packaging; its 28-file SHA-256 manifest remained identical to intake.

This assessment materially reduces the demonstrated risks but is not proof that every possible vulnerability is absent. The environment did not permit a fresh dependency installation, registry-backed `npm audit`, MariaDB integration run, or real-browser WebAuthn/TOTP exercise; those limitations are recorded below.

## Finding Matrix

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| BV-SEC-006 | High | MFA binding/invalidation did not rotate sessions or fence stale credential commits | Remediated |
| BV-SEC-007 | Medium | Current-password reauthentication had no account-scoped failure throttle | Remediated |
| BV-SEC-008 | Medium | Global rate limiting occurred after JSON and form-body parsing | Remediated |

Severity reflects BrainVault's deployment context and exploit prerequisites rather than a vendor CVSS score.

## Scope and Review Method

The review traced security-sensitive behavior across:

- Registration, password login, cookies, JWT validation, logout, password rotation, login history, TOTP, WebAuthn, MFA login sessions, and authentication-version revocation
- Page, block, attachment, share, version-history, page-cover, and collaboration authorization boundaries
- SQL construction and parameterization, search wildcard escaping, filesystem paths, upload storage, backup import/export, and archive extraction
- Markdown rendering, cached sanitized HTML, DOM insertion, KaTeX, syntax highlighting, and browser-side URL loading
- Bookmark-preview URL validation, DNS resolution, redirect validation, response-size limits, and private-address rejection
- WebSocket origin enforcement, collaboration tickets, message limits, backpressure, durable materialization, and access rechecks
- Locked direct dependencies, the lockfile registry boundary, selected official advisories relevant to security-sensitive packages, and the configured Node.js runtime floor
- Obvious private-key and common cloud, package-registry, source-control, and messaging-token patterns in the working tree and reachable Git objects

The method combined manual control-flow and data-flow review, route-to-authorization mapping, SQL interpolation inspection, targeted pattern scans, deterministic vulnerable-versus-fixed models, source assertions, syntax checks, and the project's existing dependency-free regression verifiers.

## Detailed Findings

### BV-SEC-006 — MFA credential changes did not establish a new authentication boundary

**Severity:** High  
**Weaknesses:** CWE-613 (Insufficient Session Expiration), CWE-367 (Time-of-check Time-of-use Race Condition)  
**Affected pre-fix areas:** `src/routes/mfa.routes.ts`, `src/routes/auth.routes.ts`, `public/app.js`

#### Original condition

The pre-fix TOTP and passkey mutation routes changed authentication factors without changing the user's `auth_version`. Existing cookies therefore continued to satisfy `requireAuth` after a factor was added, replaced, or removed. Other active browser sessions and collaboration WebSockets were not revoked, pending MFA login sessions and WebAuthn challenges were not invalidated as part of the factor mutation, and the browser did not accept a new credential generation because the server did not issue one.

Current-password verification and final credential persistence were also separated in several flows. For passkey enrollment, the password was checked while issuing registration options, but the final `/passkeys` request later consumed the challenge and inserted the credential without locking the user row or rechecking the request's `auth_version`. TOTP setup and verification had an equivalent split. Password change and logout rotated `auth_version`, but did not recheck the middleware-observed version under the row lock and did not clear unfinished TOTP enrollment.

#### Reproduced security outcomes

The deterministic reproduction models the actual source ordering and produced these pre-fix outcomes:

- A cookie stolen before a factor change remained valid after that change.
- A password-only login that had already observed “no MFA” could remain valid when MFA enrollment committed concurrently, because enrollment did not rotate `auth_version`.
- A passkey registration request that had already crossed middleware authentication could commit after a concurrent password change.
- An unfinished TOTP setup remained present after password change and could participate in the same stale-request race.

The reproduction is intentionally a deterministic state-machine/data-flow model, not a claim that a live MariaDB and browser exploit was executed in this container. Its assertions are paired with source tests that verify the vulnerable ordering was removed.

#### Impact

An attacker holding a valid stolen session could retain access after the legitimate user changed MFA configuration. In a narrower concurrent-request scenario, an attacker who had already passed the old authentication checks could bind a passkey after the legitimate user established a new password or factor boundary. A concurrent password-only login could also survive newly enabled MFA. These outcomes weaken recovery from session theft and can preserve or create an attacker-controlled authentication path.

#### Remediation

The following controls were added:

- Every TOTP verification/removal and passkey registration/removal now runs factor persistence and credential rotation in one database transaction.
- The transaction locks `users` with `SELECT ... FOR UPDATE` and compares the locked row's `auth_version` with the version observed by `requireAuth`.
- Successful factor changes increment `auth_version`, delete all user MFA login sessions, WebAuthn challenges, and unfinished TOTP setups, and commit those changes atomically with the factor mutation.
- The successful response disconnects process-local collaboration sockets and issues a replacement cookie containing the new `auth_version`.
- Passkey registration challenges carry the expected authentication version, and final registration rejects mismatched challenge/session generations.
- Password change and logout now recheck `auth_version` under the user-row lock and remove unfinished TOTP setup state.
- The browser increments its authentication generation and clears pending create/reset/upload task maps after accepting the replacement cookie, so responses started under the superseded cookie cannot be treated as current by those guarded operations.

This aligns with OWASP guidance to treat factor replacement as a high-risk action, avoid relying only on an active session, reauthenticate for sensitive changes, and rotate or invalidate sessions following reauthentication. NIST SP 800-63B-4 likewise treats adding or replacing an authenticator as a lifecycle binding event requiring authentication appropriate to the account's available assurance level.

#### Verification

- Source-directed test: `tests/authentication-credential-boundary.node.test.mjs`
- Reproduction: `npm run reproduce:authentication-credential-boundary`
- Focused security verifier confirms user-row locking, stale-version rejection, pending-state deletion, replacement-cookie issuance, collaboration disconnection, challenge version binding, and browser generation fencing.
- Full dependency-free test suite: 186/186 passing.

#### Residual considerations

`disconnectUserCollaborators` immediately affects hubs in the current process. A multi-instance deployment must also ensure that cross-instance WebSocket revocation converges through the existing access-recheck mechanism or an external revocation signal. Requests that fully passed authorization before a credential rotation may still finish unless their individual transaction implements a version fence; the remediation adds that fence to all credential-changing paths but does not claim to cancel every unrelated HTTP request already executing.

### BV-SEC-007 — current-password reauthentication lacked an account-scoped failure throttle

**Severity:** Medium  
**Weakness:** CWE-307 (Improper Restriction of Excessive Authentication Attempts)  
**Affected pre-fix areas:** `src/routes/auth.routes.ts`, `src/routes/mfa.routes.ts`, `src/middleware/auth-rate-limit.ts`

#### Original condition

The login endpoint had both IP- and account-oriented limits, but authenticated operations that accepted `currentPassword` did not share an account bucket. The global request limiter was primarily keyed by client address. An attacker with a stolen cookie could therefore distribute incorrect current-password attempts across addresses and avoid the account-oriented protection applied to normal login.

#### Reproduction

The deterministic model uses 12 source addresses with 120 attempts each. The pre-fix design permits all **1,440** attempts to reach current-password verification under independent address buckets. With the new shared account bucket and the configured default `AUTH_MFA_SETUP_MAX=10`, only **10** failed attempts reach verification during the window.

The model demonstrates limiter-key behavior; it is not a password-cracking benchmark.

#### Remediation

- Added `accountReauthenticationRateLimit` keyed by a SHA-256-derived user identifier rather than source address.
- Applied it after `requireAuth` and before validation/handler execution on password change, TOTP setup/removal, and passkey setup/removal.
- Reused the existing `AUTH_MFA_SETUP_WINDOW_MS` and `AUTH_MFA_SETUP_MAX` settings and documented their broader account-security purpose.
- Successful requests are not counted; failed reauthentication and failed sensitive-operation requests consume the shared account bucket.

#### Verification

The focused source test verifies the account key, limit configuration, and route placement. The security verifier checks that every current-password factor route and the password route use the shared limiter.

#### Residual considerations

The default `express-rate-limit` memory store is process-local. Production deployments with multiple application instances should use a shared rate-limit store or enforce an equivalent account-keyed limit at a trusted gateway. Rate limiting supplements rather than replaces password strength, MFA, session theft prevention, and alerting.

### BV-SEC-008 — global rate limiting occurred after request-body parsing

**Severity:** Medium  
**Weakness:** CWE-400 (Uncontrolled Resource Consumption)  
**Affected pre-fix area:** `src/app.ts`

#### Original condition

The application registered `express.json({ limit: "5mb" })` and the URL-encoded parser before the global `express-rate-limit` middleware. Once an address exceeded its request allowance, later requests could still force body parsing and allocation before the limiter returned HTTP 429.

#### Reproduction

For 25 requests rejected by the logical global limit, each carrying a 5 MiB JSON body, the source-order model attributes **131,072,000 bytes** of avoidable parsing to the pre-fix ordering. The fixed ordering attributes zero rejected-request bytes to Express body parsing. This is a deterministic middleware-order calculation, not a measured resident-memory claim.

#### Remediation

The global limiter now executes after HTTPS enforcement, CORS, and request logging but before JSON and URL-encoded parsers. Over-limit requests are rejected without entering those body parsers.

#### Verification

Both the focused test and `scripts/verify-security-hardening.mjs` assert that the first global `rateLimit({` registration precedes both parser registrations.

#### Residual considerations

Upstream proxies and the Node HTTP server still receive request bytes at the network layer. Production should also apply connection, body-size, request-rate, and timeout controls at the reverse proxy or load balancer. The application-level change specifically removes avoidable Express parsing after the rate decision.

## Reproduction Summary

Run:

```bash
npm run reproduce:authentication-credential-boundary
```

Expected deterministic result:

| Outcome | Vulnerable model | Remediated model |
| --- | ---: | ---: |
| Stolen session survives MFA factor change | `true` | `false` |
| Password-only login survives concurrent MFA enrollment | `true` | `false` |
| Replacement settings session is valid | Not issued | `true` |
| Stale passkey commit crosses password change | `true` | `false` |
| Stale passkey commit explicitly rejected | `false` | `true` |
| Unfinished TOTP setup survives password change | `true` | `false` |
| Distributed current-password attempts reaching verification | 1,440 | 10 |
| Over-limit body bytes passed to Express parsers in the model | 131,072,000 | 0 |

## Review Areas Without a Newly Reproduced Serious Vulnerability

### Authorization and version history

Page, block, attachment, share, collaboration, and page-version routes were traced to owner/editor access helpers. Page-version list/detail/reset remained owner-only, so a collaborator added later could not retrieve pre-share deleted content through version history. Object identifiers were consistently paired with user or page access predicates, and not-found normalization reduced cross-account enumeration.

### SQL injection

All query and execution sites containing template interpolation were reviewed. Interpolated SQL structure was limited to code-controlled field lists, fixed clauses, bounded numeric constants, or trusted migration/bootstrap statements. User values continued to use placeholders. Search wildcard input was escaped before `LIKE` use. No direct user-controlled SQL structure was identified.

### Cross-site scripting and DOM insertion

Markdown is rendered server-side and passed through `sanitize-html`; allowed schemes and attributes are constrained, and KaTeX trust is disabled. Browser insertion of cached block HTML consumes that sanitized server output. Other reviewed `innerHTML` uses were static templates or controlled UI content. No newly reproducible stored or reflected script execution path was identified.

### SSRF and external fetches

Bookmark preview requests validate schemes, resolve and reject private/special-use address ranges, revalidate redirects, enforce absolute deadlines, and bound response sizes. No bypass was reproduced. Remote HTTP(S) images and page covers are intentionally fetched by the viewer's browser; this can disclose viewer IP addresses to the remote host and trigger a blind browser GET. Deployments with a stricter privacy or egress threat model should proxy images through a same-origin, allowlisted, size-limited fetch service or disable remote images.

### Uploads, filesystem paths, and backup/restore

Attachment and backup paths use controlled roots and safe path segments; attachment storage roots reject project-sensitive locations including `.git`, `public`, and `docs`. Multipart routes use explicit part, field, file, header, size, and `fieldNestingDepth` limits. Backup ZIP parsing and restore paths retain the project's existing entry-count, central-directory, manifest, staged-byte, concurrency, and recovery protections. No traversal or unauthorized file-read path was reproduced.

### WebSockets and collaboration

The review rechecked exact origin handling, authenticated tickets, access verification, message-size and queue limits, backpressure, bootstrap validation, durable materialization, and permission-change disconnection. No newly reproducible cross-page or cross-user authorization bypass was identified.

### Secrets and Git history

The current working tree and reachable Git objects were scanned for common private-key, AWS, GitHub, Google, Slack, and npm-token patterns and for sensitive key/environment filenames. No credible secret was identified. The scan covered **161 commits** and **2,560 unique Git objects**. Pattern scanning cannot prove the absence of every custom secret format.

## Dependency and Runtime Review

This pass performed a targeted official-advisory review rather than claiming a complete registry audit:

| Component | Locked/configured state | Review result |
| --- | --- | --- |
| Node.js | `^22.23.2 || ^24.18.1 || >=26.5.1` | The configured minimums correspond to the July 29, 2026 security releases. The audit container itself ran Node.js 22.16.0, so it was below the project's production floor. |
| `express-rate-limit` | 8.5.2 | Newer than the affected 8.0.0–8.2.1 line described by GHSA-46wh-pxpv-q5gq. Custom IP keys use the package's `ipKeyGenerator`. |
| `multer` | 2.2.0 | Includes the reviewed aborted-upload cleanup and deeply nested-field fixes. Both multipart configurations set `fieldNestingDepth: 1` and additional strict limits. |
| `markdown-it` | 14.3.0 | The reviewed upstream issue for CVE-2025-7969 is labeled invalid; BrainVault also sanitizes rendered HTML independently. |
| Browser collaboration modules | Lockfile-controlled, same-origin routes | No third-party runtime module URL was reintroduced. |

`npm audit --omit=dev` could not complete because the configured internal registry returned HTTP 404 for its audit endpoint. A fresh `npm ci` also could not complete because the isolated package mirror did not provide a required `zod` tarball and public package-host DNS was unavailable. These environmental failures are why this section is explicitly a targeted review, not a complete Software Composition Analysis result.

## Validation Results

| Validation | Result |
| --- | --- |
| Full dependency-free Node regression suite | **186 passed, 0 failed** |
| Focused security suite | **17 passed, 0 failed** |
| Security hardening verifier | Passed |
| Data-loss guard verifier | Passed |
| Collaboration verifier | Passed |
| JavaScript/TypeScript syntax checks performed by collaboration verifier | 282 files passed |
| Lockfile registry check | 346 resolved package URLs used approved registry hosts |
| Authentication-boundary reproduction | Vulnerable and fixed assertions passed |
| Working-tree/common-token scan | No credible secret hit |
| Reachable Git-object/common-token scan | No credible secret hit across 161 commits / 2,560 objects |

## Environment Limitations

The following could not be executed in the isolated review environment:

- Fresh dependency installation and a full TypeScript production build
- Vitest suites that require installed dependencies
- Registry-backed `npm audit`
- Live MariaDB route/integration tests
- Real-browser TOTP and WebAuthn ceremonies
- Multi-instance collaboration and shared rate-limit-store tests

The source-directed tests and deterministic reproduction do not replace those production-parity checks. Before deployment, run `npm ci`, `npm audit --omit=dev`, `npm run check`, and authentication integration tests on a supported Node.js version with the production MariaDB and reverse-proxy topology.

## `.git` Preservation

The uploaded archive contained `.git` and it was retained. Git commands can update the index's stat cache even when tracked content is not changed, so the original archive's `.git` directory was restored byte-for-byte immediately before packaging and no Git command was run afterward.

- Intake `.git` files: **28**
- Intake `.git` manifest SHA-256: `01041c232cd09b6e69c643b322bc86d508c46b7b66df5f61cec01b82223fead4`
- Packaged `.git` files: **28**
- Packaged `.git` manifest SHA-256: `01041c232cd09b6e69c643b322bc86d508c46b7b66df5f61cec01b82223fead4`
- Missing, added, or byte-different `.git` files: **0**

## Files Changed by This Remediation

- `docs/README.md`
- `docs/configuration/2026-07-28/configuration.md`
- `docs/security/2026-08-06/security-review-and-remediation-report.md`
- `package.json`
- `public/app.js`
- `scripts/reproduce-authentication-credential-boundary.mjs`
- `scripts/verify-security-hardening.mjs`
- `src/app.ts`
- `src/middleware/auth-rate-limit.ts`
- `src/routes/auth.routes.ts`
- `src/routes/mfa.routes.ts`
- `tests/authentication-credential-boundary.node.test.mjs`
- `tests/page-create-auth-boundary.node.test.mjs`
- `tests/page-version-reset-idempotency.node.test.mjs`

No separate raw audit log was added to the repository.

## Recommended Deployment Follow-up

1. Run all install-dependent checks on Node.js 22.23.2, 24.18.1, 26.5.1, or a later supported security release.
2. Back account and global rate limits with a shared store or trusted edge control when running more than one application instance.
3. Add production-parity integration tests that deliberately interleave password change, logout, TOTP verification, passkey registration, and password-only login around the `auth_version` row lock.
4. Notify users through an independent channel when an authenticator is added, replaced, or removed; consider recovery codes if the product threat model requires resilient MFA recovery.
5. Decide explicitly whether remote images/covers are acceptable under the privacy and blind-GET threat model.

## References

- [OWASP Multifactor Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [NIST SP 800-63B-4 — Authenticator Event Management](https://pages.nist.gov/800-63-4/sp800-63b/events/)
- [GitHub Advisory GHSA-46wh-pxpv-q5gq — express-rate-limit IPv4-mapped IPv6 behavior](https://github.com/advisories/GHSA-46wh-pxpv-q5gq)
- [Multer Advisory GHSA-72gw-mp4g-v24j — deeply nested field names](https://github.com/expressjs/multer/security/advisories/GHSA-72gw-mp4g-v24j)
- [Multer Advisory GHSA-3p4h-7m6x-2hcm — aborted upload cleanup](https://github.com/expressjs/multer/security/advisories/GHSA-3p4h-7m6x-2hcm)
- [Node.js 22.23.2 security release](https://nodejs.org/en/blog/release/v22.23.2)
