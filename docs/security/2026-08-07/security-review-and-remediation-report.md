# BrainVault Security Review and Remediation Report

**Review date:** August 7, 2026  
**Input archive:** `BrainVault.zip`  
**Input archive SHA-256:** `f2a8207e74d6a7b1eaea7fdf61fb36b087ebb289d1f3824268a4a39cc40973b3`  
**Repository HEAD at intake:** `a80f3d795da439688d09859cb5c9c86ed1ba95e5`  
**Intake branch:** `main`  
**Intake commit:** `feat(collaboration): add real-time remote cursor presence.`  
**Repository scope:** The complete uploaded project, including the retained `.git` directory and reachable history  
**Assessment type:** Manual source review, source-directed exploit reproduction, remediation, and dependency-free regression verification

## Executive Summary

No Critical-severity vulnerability was reproduced in the reviewed scope. Two High-severity and two Medium-severity weaknesses were confirmed and remediated:

1. **High - collaboration presence fan-out could amplify a small cursor event into hundreds of kilobytes per peer.** A valid editor could store a profile image close to the 512 KiB raw avatar limit, then send otherwise small awareness updates. The server attached the full data URL to every cursor update and broadcast it to every other participant. Under the configured 64-client room and 600-frame-per-minute limits, the deterministic upper-bound model reached approximately **24.62 GiB of outbound room traffic per minute** from one editor connection.
2. **High - replayed Yjs updates and client-requested snapshots caused unnecessary persistence and broadcast work.** The server persisted and re-broadcast an update even when applying it did not change the canonical Yjs document. It also accepted repeated full-document snapshots whenever the durable cursor matched, deleted older history, and broadcast the full snapshot to every client. A maximum-size 16 MiB snapshot could therefore produce **1 GiB of room fan-out per accepted request**, in addition to database churn.
3. **Medium - the production session cookie was vulnerable to cross-subdomain cookie shadowing and ambiguous duplicate-cookie selection.** The unprefixed cookie name could be set as a parent-domain cookie by a compromised sibling subdomain. The parser accepted the first matching value when duplicate names were present, permitting session swapping, login confusion, or forced authentication failure depending on browser cookie ordering and the injected token.
4. **Medium - access logs recorded note search terms and other URL query data.** Morgan's standard `combined` and `dev` formats log the original request target. Requests such as `/api/search?q=...` therefore placed user-entered note search terms into ordinary access logs; the production referrer field could also retain query data.

The remediation separates infrequent collaborator identity messages from frequent cursor messages, enforces a 64 KiB collaboration-only avatar budget, ignores state-equivalent regular Yjs replays, accepts compaction only when the submitted snapshot is state-equivalent and at least 200 history entries justify it, and replaces full-snapshot peer fan-out with a small durable-cursor control message. Secure deployments now use `__Host-brainvault_session`, reject ambiguous duplicate cookies, and stop accepting the legacy cookie name. Access logging now strips query strings and fragments from the request target and referrer before Morgan formats them.

The final dependency-free Node suite completed with **193 passing tests and 0 failures**. The focused security command completed with **22 passing tests and 0 failures**. The security, data-loss, collaboration, syntax, and lockfile verifiers passed. The original `.git` directory is restored from the uploaded archive immediately before packaging and is verified by a content manifest, as described below.

This review materially reduces the demonstrated risks, but it is not proof that every possible vulnerability is absent. The isolated environment did not permit a fresh dependency installation, registry-backed `npm audit`, a full TypeScript build with installed package types, a live MariaDB integration run, or a real multi-browser WebSocket exercise. Those limitations are recorded explicitly rather than being treated as successful checks.

## Finding Matrix

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| BV-SEC-009 | High | Large avatar data was repeated in every collaboration awareness broadcast | Remediated |
| BV-SEC-010 | High | State-equivalent Yjs replays and snapshots caused database and network amplification | Remediated |
| BV-SEC-011 | Medium | Unprefixed session cookie and first-match parsing allowed cookie shadowing ambiguity | Remediated |
| BV-SEC-012 | Medium | Search terms and other URL query data were written to access logs | Remediated |

Severity reflects BrainVault's deployment model and exploit prerequisites rather than a vendor CVSS score.

## Scope and Review Method

The review covered 331 source-like JavaScript, TypeScript, SQL, and test files comprising approximately 70,384 lines, plus configuration, documentation, lockfile data, and reachable Git history. Security-sensitive flows were traced across:

- Registration, login, JWT validation, session cookies, logout, password changes, TOTP, WebAuthn, authentication-version revocation, login history, and account lockout
- Page, block, attachment, cover, share, archive, version-history, collaboration, and backup authorization boundaries
- Express middleware order, CORS, HTTPS enforcement, reverse-proxy trust, request limits, error handling, static-file routing, and access logging
- SQL construction, placeholder use, search wildcard handling, transactions, row locks, idempotency receipts, and cross-page ownership checks
- Upload parsing, file signatures, storage roots, download disposition, attachment reconciliation, ZIP parsing, restore staging, manifest verification, and recovery behavior
- Markdown rendering, sanitization, cached HTML, DOM insertion, KaTeX, syntax highlighting, data URLs, remote image loading, and iframe policy
- Bookmark preview SSRF controls, DNS resolution, special-use address rejection, redirects, deadlines, content limits, and response decoding
- WebSocket origin checks, signed collaboration tickets, connection limits, message limits, backpressure, Yjs validation, bootstrap, snapshots, materialization, permission rechecks, and session revocation
- Locked direct dependencies, approved lockfile registry hosts, selected current official advisories relevant to exposed packages, and the configured runtime floor
- Common private-key and cloud, source-control, package-registry, AI-provider, and messaging-token patterns in the current tree and reachable Git blobs

The method combined manual control-flow and data-flow review, route-to-authorization mapping, dangerous-sink inspection, SQL interpolation review, deterministic vulnerable-versus-fixed models, source assertions, dependency-free tests, syntax verification, lockfile verification, and targeted official security guidance. No exploit traffic was sent to any external system.

## Detailed Findings

### BV-SEC-009 - Large avatar data was repeated in every collaboration awareness broadcast

**Severity:** High  
**Weakness:** CWE-400 (Uncontrolled Resource Consumption)  
**Affected pre-fix areas:** `src/lib/collaboration-server.ts`, `src/lib/profile.ts`, `public/collaboration.js`

#### Original condition

BrainVault permits a validated profile avatar containing up to 512 KiB of decoded image data. Base64 and the data-URL prefix expand that value to approximately 699 KiB in JSON. The pre-fix `publicPresence()` function included `avatar_data` in its return value, and `broadcastPresenceUpdate()` used that complete object for every awareness update. Cursor movement, selection movement, and focus changes therefore caused the full avatar to be serialized and transmitted to every other participant each time.

The existing inbound control message remained small because the client sent only awareness state. The expansion occurred after authentication on the server, so an editor could create a high outbound-to-inbound ratio without sending an oversized WebSocket frame.

#### Reproduction

Run:

```bash
npm run reproduce:security-followup
```

The deterministic model uses the actual 512 KiB raw profile-avatar limit, a 64-client room, and the configured 600-frame-per-minute connection limit. It produced:

- Pre-fix serialized awareness message: **699,292 bytes**
- Fixed frequent awareness message: **158 bytes**
- Pre-fix theoretical fan-out: **24.62 GiB per minute**
- Fixed frequent-event theoretical fan-out: **5.70 MiB per minute**

The calculation is a protocol upper-bound model, not a measured network benchmark. It demonstrates the amplification inherent in the pre-fix message shape.

#### Impact

A malicious or compromised editor could degrade collaboration for every participant in a page, consume application outbound bandwidth, increase JSON serialization and allocation pressure, and contribute to WebSocket send-queue backpressure. Because the event was authorized and structurally valid, ordinary authentication and message-size checks did not prevent the amplification.

#### Remediation

- Added `src/lib/collaboration-presence.ts` with a collaboration-specific avatar limit of 64 KiB.
- Presence identity is sent when a client joins and in the initial presence roster, rather than on every cursor event.
- Frequent awareness and synchronization updates contain only the connection ID, bounded cursor state, and synchronization flag.
- The browser merges partial awareness updates into its existing presence record so user identity remains available.
- Avatars above the collaboration budget fall back to the existing initials UI; the profile avatar itself is not deleted or modified.

This follows the principle that frequently broadcast WebSocket messages should be small, bounded, and rate-limited. It also removes user-profile data from a high-frequency protocol path where that data is not required for each event.

#### Verification

- `tests/security-followup-remediation.node.test.mjs` verifies the avatar budget and partial-presence client merge.
- `scripts/verify-security-hardening.mjs` verifies that frequent broadcasts omit identity and initial messages include it explicitly.
- `scripts/reproduce-security-followup.mjs` verifies more than a 1,000-fold reduction in the modeled frequent-message fan-out.

#### Residual considerations

Initial presence exchange can still include small avatars and remains bounded by the 64-client page limit. Deployments facing hostile authenticated collaborators should also enforce per-user connection and egress controls at the reverse proxy or WebSocket gateway and alert on rapid reconnect churn.

### BV-SEC-010 - State-equivalent Yjs replays and snapshots caused database and network amplification

**Severity:** High  
**Weaknesses:** CWE-400 (Uncontrolled Resource Consumption), CWE-770 (Allocation of Resources Without Limits or Throttling)  
**Affected pre-fix areas:** `src/lib/collaboration-server.ts`, `src/lib/yjs-validation.ts`, `public/collaboration.js`

#### Original condition

Yjs document updates are designed to be idempotent. Applying the same update multiple times can leave the document unchanged. The pre-fix server nonetheless inserted every accepted regular update into `page_yjs_updates`, advanced the durable cursor, and broadcast the update envelope to every room client.

The snapshot path had a larger amplification factor. A client could submit a full Yjs state update with the current base update ID. The server persisted it as a snapshot, deleted all older update rows, replaced the room history, and broadcast the complete snapshot to every client. The server did not verify that the snapshot was state-equivalent to the canonical room or that enough history existed to justify compaction.

#### Reproduction

The source-directed model and pre-fix control flow establish two reproducible outcomes:

- An exact regular-update replay could be accepted, inserted, and broadcast even though Yjs application was state-equivalent.
- A 16 MiB snapshot sent to a full 64-client room caused **1,024 MiB** of binary fan-out per accepted snapshot, before protocol overhead, while also inserting a new row and deleting prior history.

The fixed model replaces the full peer broadcast with 2,709 bytes of aggregate `compaction-complete` control messages for the other 63 clients in the same maximum-room scenario. The deterministic script verifies a reduction greater than 100,000-fold for that snapshot fan-out path.

#### Impact

A valid editor could repeatedly consume database write capacity, grow or churn update history, trigger large in-process allocations, and multiply outbound network usage across all collaborators. Replayed regular updates also inflated the history count and could cause premature compaction attempts. The attack did not require bypassing authorization or crafting an invalid Yjs message.

#### Remediation

- `applyValidatedYjsUpdate()` now reports whether the candidate canonical state differs from the current canonical state.
- A state-equivalent regular update is acknowledged without SQL persistence or room-wide binary broadcast after the initial bootstrap has been established.
- A client-requested snapshot is rejected if applying it changes the canonical document.
- A state-equivalent snapshot is rejected until at least 200 durable history entries exist, preventing compaction as an arbitrary high-cost operation.
- Accepted snapshots still replace durable history, but peers receive only a small `compaction-complete` cursor message because their in-memory document is already equivalent.
- The sender receives the ordinary durable acknowledgement, and every client updates its durable cursor and materialization schedule without reapplying a full document.
- Snapshot rejection reasons are explicit: `snapshot-changed-document`, `snapshot-too-early`, `snapshot-base-mismatch`, or `room-stale`.

The cross-instance durable-cursor checkpoint and existing page-access, lineage, pending-write, message-size, byte-rate, and frame-rate controls remain in place.

#### Verification

- `tests/security-followup-remediation.node.test.mjs` covers regular no-change decisions, changed-document snapshot rejection, early-compaction rejection, and valid state-equivalent compaction.
- Source assertions verify that the server has separate ignore, reject, persist, and small-control-message paths.
- The browser test assertions verify durable-cursor handling for `compaction-complete` and snapshot rejection.
- `npm run verify:collaboration` passed the collaboration invariants and syntax checks.
- `npm run reproduce:security-followup` passed the vulnerable-versus-fixed amplification assertions.

#### Residual considerations

An authorized editor can still generate legitimate document changes, and validating a Yjs update requires bounded CPU and memory. Existing limits cap document/update size at 16 MiB, connection frames at 600 per minute, bytes at 64 MiB per minute, page clients at 64, user clients at 8, and pending room writes at 64/32 MiB. Production infrastructure should add process memory limits, shared per-user abuse controls, WebSocket egress monitoring, and load tests using the largest supported document.

### BV-SEC-011 - Unprefixed session cookie and first-match parsing allowed cookie shadowing ambiguity

**Severity:** Medium  
**Weakness:** CWE-384 (Session Fixation)  
**Affected pre-fix area:** `src/lib/session-cookie.ts`

#### Original condition

The production cookie was named `brainvault_session`, had no `Domain` attribute, and was correctly marked `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`. However, the unprefixed name could also be created as a parent-domain cookie by a sibling subdomain. Browsers can send both a host-only cookie and a parent-domain cookie with the same name. The pre-fix parser returned the first matching value, making authentication dependent on duplicate-cookie ordering.

A sibling-domain attacker could inject an invalid token to cause authentication failure or inject a valid token for an attacker-controlled account to create session swapping/login confusion. JWT signature validation does not prevent the latter because the injected token can be a legitimate token obtained by the attacker for the attacker's own account.

#### Reproduction

The fixed regression test uses the ambiguous header:

```text
brainvault_session=parent-domain; brainvault_session=host-only
```

The pre-fix loop returned the first value. The new parser returns `null` unless exactly one cookie with the selected name is present. Secure deployments additionally select a name that a parent domain cannot validly create.

#### Impact

The most direct effect is a denial of the victim's existing authenticated session. Under session swapping, a victim could unknowingly interact with an attacker-controlled account and place private content into that account. Exploitability requires an attacker-controlled sibling subdomain or an equivalent ability to set a parent-domain cookie.

#### Remediation

- HTTPS deployments now use `__Host-brainvault_session`.
- The cookie retains `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`, and no `Domain` attribute is introduced.
- Cookie parsing fails closed when zero, multiple, empty, or malformed encoded values are present.
- Setting or clearing the secure cookie also expires the legacy unprefixed host-only cookie as a migration cleanup.
- The server does not accept the legacy cookie name in secure mode, so existing secure deployments require one sign-in after deployment.
- Local HTTP development continues to use the legacy name because browsers reject `__Host-` cookies without `Secure` transport.

#### Verification

The focused test verifies secure and development name selection, successful single-cookie decoding, duplicate rejection, and malformed encoding rejection. Source assertions verify that the production cookie path uses the policy helper and the unique-cookie parser.

#### Residual considerations

The control assumes HTTPS is enabled correctly and that reverse-proxy trust settings cannot be spoofed. Operators should keep unrelated applications off the BrainVault registrable domain where practical and should monitor for unexpected legacy cookies during rollout.

### BV-SEC-012 - Search terms and other URL query data were written to access logs

**Severity:** Medium  
**Weakness:** CWE-532 (Insertion of Sensitive Information into Log File)  
**Affected pre-fix area:** `src/app.ts`

#### Original condition

The application used Morgan's standard `combined` format in production and `dev` format outside production. Both include the request URL. The production format also includes the referrer. BrainVault's search endpoint places the user-entered query in `q`, so normal access logging recorded note-related search terms. Other future endpoints could place reset tokens, share material, or identifiers in a query string and inherit the same exposure.

#### Reproduction

For the request target:

```text
/api/search?q=board+acquisition+target
```

The pre-fix format retained the complete value. The new token returns:

```text
/api/search
```

The same helper removes a fragment and removes query/fragment data from the referrer. The deterministic test also verifies that a URL consisting only of a query falls back to `-` rather than logging the sensitive value.

#### Impact

Anyone or any system with access to ordinary application, container, reverse-proxy-forwarded, or aggregated logs could obtain private search vocabulary. Log retention and replication can make this exposure persist longer and reach more operators than the underlying request.

#### Remediation

- Added `src/lib/access-log.ts` with request-target and referrer sanitization.
- Registered Morgan `safe-url` and `safe-referrer` tokens.
- Replaced the built-in formats with explicit production and development formats that use only the sanitized tokens.
- No additional audit log file was added.

#### Verification

The focused test verifies query and fragment removal and ensures the production format does not reference raw `:url` or `:referrer` tokens. The security verifier confirms that `combined` and `dev` are no longer passed directly to Morgan.

#### Residual considerations

Upstream proxies, content-delivery networks, load balancers, browser history, and external observability agents may still log full URLs independently. Operators should apply equivalent query redaction there and avoid designing sensitive values into URLs.

## Reproduction Summary

Run:

```bash
npm run reproduce:security-followup
```

Expected deterministic output values:

| Measure | Pre-fix model | Remediated model |
| --- | ---: | ---: |
| Awareness message with maximum profile avatar | 699,292 bytes | 158 bytes for frequent events |
| 63-peer awareness fan-out at 600 events/minute | 24.62 GiB/minute | 5.70 MiB/minute |
| Maximum snapshot fan-out in a 64-client room | 1,024 MiB | 2,709 aggregate control bytes to peers |
| State-equivalent regular update persisted | Yes | No |
| State-changing client snapshot accepted as compaction | Yes | No |
| State-equivalent snapshot accepted before 200 history entries | Yes | No |
| Ambiguous duplicate session cookie accepted | First matching value | No |
| Search query retained in application access log | Yes | No |

## Review Areas Without a Newly Reproduced Serious Vulnerability

### Authentication, authorization, and object ownership

Authentication middleware validates signed JWTs with the expected algorithm, issuer, audience, expiry, user existence, and `auth_version`. Password/factor changes and logout use the project's existing credential-boundary controls. Page, block, attachment, version, cover, share, collaboration, and data routes were traced to owner/editor access helpers. Identifiers were consistently paired with account or page access checks. No new authentication bypass, horizontal privilege escalation, or owner-only version-history disclosure was reproduced.

### SQL injection

All application query and execution sites using template interpolation were reviewed. User values continued to use placeholders. Dynamic SQL structure was limited to code-controlled field lists, fixed clauses, trusted migration/bootstrap statements, or bounded numeric constants. Search wildcard input was escaped before `LIKE` use. No direct user-controlled SQL syntax path was identified.

### Cross-site scripting and DOM insertion

Server-rendered Markdown is sanitized before cached HTML is returned. Allowed schemes and attributes remain constrained, and KaTeX trust is disabled. Browser `innerHTML` assignments were traced to sanitized server output, localization resources, static templates, or syntax-highlighter output. Backup import does not trust a supplied HTML cache and re-renders content. No newly reproducible stored or reflected script execution path was identified.

### SSRF and remote content

Bookmark preview requests restrict schemes, resolve hosts, reject private and special-use address ranges, pin validated addresses for connection, revalidate redirects, enforce deadlines, and cap response sizes. No bypass was reproduced. User-configured remote images and covers are intentionally fetched by the viewer's browser, which can disclose the viewer's IP address to the remote host; a stricter privacy deployment should proxy or disable remote images.

### Uploads, filesystem paths, and backup/restore

Attachment and backup paths remain rooted under controlled directories and use safe generated or validated path components. Attachment storage roots reject project-sensitive locations including `.git`. Multipart routes use explicit field, file, header, count, size, and nesting limits. ZIP import retains entry-count, central-directory, staged-byte, expansion, manifest, hash, ownership, and recovery checks. No traversal, arbitrary file write, unauthorized file read, or backup-based stored-XSS path was reproduced.

### WebSocket authorization and lifecycle

The collaboration upgrade requires an exact allowed `Origin`, an authenticated signed ticket bound to page, user, authentication version, document epoch, audience, and scope, and a current database access check. Active connections are bounded globally, per page, and per user; access and authentication versions are rechecked; logout and credential changes disconnect process-local sockets. No cross-page or cross-user collaboration authorization bypass was reproduced.

### Command execution and deserialization

No runtime application path was found that forwards user-controlled input to a shell, `eval`, dynamic `Function`, or child process. Development and verification scripts use fixed executables and argument arrays. JSON and WebSocket controls use ordinary parsing plus schema or structural validation. No new remote-code-execution path was identified.

### Secrets and Git history

The current working tree and reachable Git blobs were scanned for high-confidence private-key and hosted-service credential/token patterns. No credible hit was identified. The reachable repository contained **163 commits**, **2,922 reachable objects**, and **1,668 unique blobs**. Pattern scanning cannot prove the absence of every custom secret format, encrypted secret, or credential split across files.

## Dependency and Runtime Review

The lockfile resolves the following security-relevant direct packages, among others:

| Component | Locked state | Review result |
| --- | --- | --- |
| Node.js runtime policy | `^22.23.2 || ^24.18.1 || >=26.5.1` | The review container ran Node.js 22.16.0, below the project's declared production floor. Dependency-free checks were run with the container version; production should honor the declared floor. |
| `express` | 5.2.1 | No source-level use of deprecated Express response execution features was identified. |
| `express-rate-limit` | 8.5.2 | Global limiting occurs before body parsing; account-sensitive routes retain their focused controls. Multi-instance deployments still require a shared store or equivalent gateway policy. |
| `multer` | 2.2.0 | This is the patched version identified by the reviewed 2026 aborted-upload and deeply nested field-name advisories. BrainVault also configures strict multipart limits including `fieldNestingDepth: 1`. |
| `jsonwebtoken` | 9.0.3 | Verification call sites constrain algorithms and expected token claims. |
| `sanitize-html` | 2.17.5 | Markdown output is sanitized with an explicit allow policy before browser insertion. |
| `yjs` | 13.6.31 | Updates are validated in isolated candidate documents and bounded before canonical replacement. |

`npm audit --omit=dev` could not complete because the configured isolated registry did not expose a working audit endpoint. A fresh `npm ci` could not complete because the isolated cache lacked the required `zod` tarball and public package-host DNS was unavailable. The lockfile registry verifier did pass and found **346 resolved package URLs** using approved hosts. This section is therefore a targeted dependency review, not a complete Software Composition Analysis result.

## Validation Results

| Validation | Result |
| --- | --- |
| Full dependency-free Node regression suite | **193 passed, 0 failed** |
| Focused `npm run verify:security` test set | **22 passed, 0 failed** |
| Security hardening verifier | Passed |
| Data-loss guard verifier | Passed |
| Collaboration verifier | Passed |
| JavaScript/TypeScript syntax checks performed by collaboration verifier | **290 files passed** |
| Lockfile registry check | **346 resolved URLs used approved hosts** |
| Follow-up security reproduction | All vulnerable-versus-fixed assertions passed |
| Working-tree high-confidence secret scan | No hit |
| Reachable-history high-confidence secret scan | No hit across 163 commits / 1,668 unique blobs |

Commands used for the final dependency-free verification:

```bash
node --experimental-strip-types --test tests/*.node.test.mjs
npm run verify:security
npm run lockfile:check
npm run verify:data-loss
npm run verify:collaboration
npm run reproduce:security-followup
```

## Environment Limitations

The following production-parity checks could not be completed in the isolated review environment:

- Fresh dependency installation
- Registry-backed `npm audit`
- Full TypeScript production build with installed dependencies and type declarations
- Vitest suites that require installed packages
- Live MariaDB route and migration integration tests
- Real-browser authentication, upload, backup, and WebSocket collaboration exercises
- Multi-instance collaboration, shared rate-limit-store, reverse-proxy, and sustained-load tests

A build command was attempted, but its diagnostics were dominated by missing dependency modules and type declarations after the failed installation. Those diagnostics do not establish that the patched source has a TypeScript error. Before deployment, use a supported Node.js version and run `npm ci`, `npm audit --omit=dev`, `npm run check`, database integration tests, and a multi-client collaboration load test in a networked CI environment.

## `.git` Preservation

The uploaded archive contained `.git`, and it is not deleted. Git commands can update index metadata even when tracked project content is unchanged, so packaging uses this procedure:

1. Extract the original `.git` directory again from the uploaded archive.
2. Replace the review workspace's `.git` directory with that fresh extraction using metadata-preserving filesystem copy operations.
3. Run no Git command against the packaged workspace afterward.
4. Compare file count, content manifest, and extracted-package contents against the fresh intake copy.

Intake values from a fresh archive extraction, calculated before any Git command touched that extraction:

- `.git` regular files: **28**
- `.git` content manifest SHA-256: `7e5e762dfbc885a19bce9a61b5c9a70d0ceaf3a66bace9fd7b52ffbf1e467ecc`
- HEAD: `a80f3d795da439688d09859cb5c9c86ed1ba95e5`
- Branch: `main`

The final archive verification records these same file and manifest values.

## Files Added or Modified by This Review

- `package.json`
- `public/collaboration.js`
- `scripts/reproduce-security-followup.mjs`
- `scripts/verify-security-hardening.mjs`
- `src/app.ts`
- `src/lib/access-log.ts`
- `src/lib/collaboration-presence.ts`
- `src/lib/collaboration-protocol.ts`
- `src/lib/collaboration-server.ts`
- `src/lib/collaboration-update-policy.ts`
- `src/lib/session-cookie-policy.ts`
- `src/lib/session-cookie.ts`
- `src/lib/yjs-validation.ts`
- `tests/security-followup-remediation.node.test.mjs`
- `docs/security/2026-08-07/security-review-and-remediation-report.md`

No standalone audit-log artifact was created.

## Deployment Notes

1. Deploy only behind correctly configured HTTPS and preserve the existing exact-origin, CORS, and trusted-proxy settings.
2. Expect users with an existing secure `brainvault_session` cookie to sign in once so the server can issue `__Host-brainvault_session`.
3. Apply equivalent query-string redaction to reverse-proxy, CDN, ingress, APM, and hosted log pipelines.
4. Use a shared rate-limit store or trusted gateway controls when running more than one application instance.
5. Alert on repeated snapshot rejection, WebSocket rate-limit closure, abnormal reconnect churn, and high per-page egress without logging message bodies, tokens, or note content.
6. Run the production-parity checks listed under Environment Limitations before release.

## References

- Yjs, "Document Updates": https://docs.yjs.dev/api/document-updates
- OWASP, "WebSocket Security Cheat Sheet": https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html
- OWASP, "Session Management Cheat Sheet": https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP, "Application Logging Vocabulary Cheat Sheet": https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html
- OWASP, "Business Logic Security Cheat Sheet": https://cheatsheetseries.owasp.org/cheatsheets/Business_Logic_Security_Cheat_Sheet.html
- Public advisory GHSA-3p4h-7m6x-2hcm — Multer aborted-upload cleanup
- Public advisory GHSA-72gw-mp4g-v24j — Multer deeply nested field names
