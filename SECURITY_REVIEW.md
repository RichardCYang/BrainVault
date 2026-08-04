# BrainVault Security Review and Remediation Report

**Review date:** August 4, 2026  
**Repository commit at intake:** `e431023347d3fcfce508da78e8888fa84858996e`  
**Review target:** The complete uploaded BrainVault repository, including the retained `.git` directory and history

## Executive Summary

A security-focused source review, dependency review, reproducibility check, and regression-test pass were performed against the uploaded BrainVault project.

No critical application-source exploit was reproduced in the reviewed authentication, authorization, server-side request, file handling, backup/restore, rendering, or collaboration paths. Two actionable security findings were identified and remediated:

1. **High — vulnerable transitive IP classification dependency.** The lockfile selected `ip-address@10.2.0`, which is affected by multiple 2026 trust-boundary classification vulnerabilities. It was upgraded and pinned to `10.3.1` through an npm override and lockfile update.
2. **Medium — remotely executed collaboration runtime.** The browser dynamically imported the Yjs runtime from a third-party CDN. The exact version was pinned, but dynamic ES module imports do not provide the same Subresource Integrity protection used by the project's classic KaTeX script. Yjs and its browser dependencies are now served from same-origin, lockfile-controlled packages.

The remediation adds focused security regression tests and updates the existing security and collaboration verifiers. The repository's `.git` directory is retained; it was not deleted or replaced.

This review materially reduces the identified risk. It is not a mathematical guarantee that no vulnerability exists, especially for deployment-specific behavior outside the supplied environment.

## Scope and Method

The review covered:

- Authentication, session cookies, JWT validation, session revocation, login lockout, TOTP, and WebAuthn
- Object-level authorization for pages, blocks, attachments, sharing, versions, and collaboration
- Server-side URL fetching and DNS-rebinding/redirect behavior
- Attachment upload, signature validation, private storage, and download response controls
- Backup export/import, ZIP parsing, path handling, manifest validation, conflicts, and transaction recovery
- Markdown, HTML sanitization, KaTeX, link handling, cached HTML, and browser DOM insertion points
- WebSocket origin enforcement, collaboration tickets, resource limits, and durable materialization
- SQL construction, process execution, file paths, cryptographic APIs, and security-sensitive randomness
- Content Security Policy and third-party browser code execution
- npm dependency lock state and publicly disclosed advisories relevant to selected versions
- Obvious credential and private-key patterns in the working tree and Git object history

The review combined manual source tracing, targeted static searches, dependency/advisory verification, focused reproduction checks, source-level security assertions, syntax checks, and the repository's dependency-free Node regression suite.

## Findings and Remediation

### BV-SEC-001 — Vulnerable `ip-address@10.2.0` Transitive Dependency

**Severity:** High  
**Status:** Remediated

#### Original condition

`express-rate-limit@8.5.2` declared `ip-address` as a transitive dependency, and the supplied lockfile selected `ip-address@10.2.0`.

That selected version falls within the affected ranges of:

- **CVE-2026-69192 / GHSA-mwp4-54f8-5fhr:** leading-zero IPv4 octets can be interpreted differently by the library and the network resolver; affected through `10.3.0`, fixed in `10.3.1`.
- **CVE-2026-69198 / GHSA-4xrf-jv44-h6hh:** attacker-controlled CIDR suffixes can suppress special-use classification; affected `10.1.1` through `10.2.1`, fixed in `10.2.2`.
- **CVE-2026-54272 / GHSA-22jq-vg5j-6vgg:** IPv4-mapped and NAT64 IPv6 addresses can be misclassified; affected `10.1.1` through `10.2.0`, fixed in `10.2.1`.

The highest-severity issue is directly reproducible at the URL parsing boundary: Node canonicalizes `http://012.0.0.1/` to host `10.0.0.1`, while affected `ip-address` releases can classify the original spelling as a different public address. A component relying on the affected classifier can therefore make an incorrect trust or rate-limit keying decision.

BrainVault's bookmark preview SSRF defense does **not** use this package and was separately reviewed. It resolves all destination addresses, rejects the request if any answer is unsafe, pins the validated address into the connection lookup, repeats validation after every redirect, restricts ports, disables content encoding, applies absolute time and byte limits, and rejects non-HTML responses. No bookmark SSRF bypass was reproduced.

#### Fix

- Added an npm override pinning `ip-address` to `10.3.1`.
- Updated the lockfile entry, tarball location, and integrity value to the patched release.
- Added a regression test that fails if an affected version re-enters the lockfile.
- Added a canonicalization regression check for the leading-zero IPv4 case.

#### Verification

- The lockfile contains only `ip-address@10.3.1`.
- The expected fixed-package integrity value is asserted by the regression test.
- The public advisory reproduction input is normalized by Node to the internal address expected by the advisory.

### BV-SEC-002 — Third-Party Remote Yjs Runtime Execution

**Severity:** Medium  
**Status:** Remediated

#### Original condition

The collaboration client dynamically imported the exact Yjs version from a jsDelivr ES module URL. Version pinning reduced accidental drift, but the browser still executed a third party's runtime response. Dynamic `import()` does not accept an integrity attribute equivalent to the Subresource Integrity declaration used by the project's classic KaTeX script.

This created an avoidable supply-chain and availability trust dependency in the collaboration path. Compromise or unexpected alteration of the remote delivery path could execute code with the application's browser origin privileges.

#### Fix

- Changed the collaboration client to import `/vendor/yjs/yjs.mjs` from the BrainVault origin.
- Added exact same-origin routes backed by the lockfile-controlled `yjs`, `lib0`, and `isomorphic.js` npm packages.
- Restricted the exposed `lib0` subtree to JavaScript module requests, denied dotfiles, disabled indexes and redirects, and applied immutable caching, `nosniff`, and same-origin resource-policy headers.
- Added a compact import map for Yjs bare module specifiers.
- Authorized only that exact inline import map with a SHA-256 CSP hash.
- Removed the remote Yjs URL from the Content Security Policy.
- Updated collaboration documentation and regression verifiers.

The lockfile selects `yjs@13.6.31`, `lib0@0.2.99`, and `isomorphic.js@0.2.5`. Yjs publishes `dist/yjs.mjs` as its import entry, lib0 publishes ESM modules under `lib0/[module]`, and `isomorphic.js` publishes `browser.mjs` as its browser import entry.

#### Verification

- The collaboration source contains no remote Yjs module URL.
- The CSP contains no remote Yjs allowance.
- The import-map source hashes to the exact CSP value.
- Server route, import-map, package-version, and remote-reference invariants are covered by regression tests and source verifiers.

## High-Risk Areas Reviewed Without a Reproduced Exploit

### Authentication and sessions

JWT verification fixes the expected algorithm, issuer, and audience; authorization uses verified claims rather than decoded untrusted claims. Session cookies are `HttpOnly`, `SameSite=Strict`, and secure under HTTPS mode. Session invalidation is tied to an authentication version. Sensitive state-changing authentication routes enforce origin and JSON expectations. Account and source-IP controls are present for login and MFA abuse. TOTP replay prevention and WebAuthn challenge, origin, RP ID, and user-verification checks are implemented.

### Object-level authorization

Page, block, attachment, sharing, version, and collaboration operations trace ownership or editor rights before returning or mutating protected resources. Unauthorized access is generally mapped to a non-enumerating not-found response. No reproducible insecure direct object reference was identified in the reviewed routes.

### Server-side URL fetching

The bookmark preview implementation validates the normalized protocol, forbids credentials and non-approved ports, resolves and validates every address, rejects mixed safe/unsafe DNS answer sets, pins the selected address to the outbound connection, repeats validation for redirects, and limits time, size, redirects, content type, and content encoding. No DNS-rebinding, redirect, alternate-IPv4-spelling, IPv4-mapped IPv6, or oversized-response bypass was reproduced from the supplied source and tests.

### Attachments

Attachments are stored outside the public static directory using generated names. Upload count, field nesting, and size are bounded. File signatures are checked in addition to metadata. Downloads use restrictive cache and content-sniffing headers, and potentially active content is served with sandboxing controls. No path traversal or arbitrary-file retrieval path was reproduced.

### Backup and restore

The ZIP parser applies entry, compressed-size, uncompressed-size, expansion-ratio, path, filename, method, CRC, and manifest restrictions. Restore validates hashes and structure, rerenders derived HTML rather than trusting imported cached HTML, handles conflicts explicitly, and uses transactions and recovery markers for destructive phases. No ZIP-slip, manifest substitution, decompression-bomb, or trusted-HTML import bypass was reproduced.

### Rendering and DOM sinks

Markdown permits source HTML only before sanitize-html processing. The sanitizer restricts tags, attributes, URL schemes, and embedded frames. Links receive opener protections, images use a no-referrer policy, KaTeX runs with trust disabled, and imported content is rerendered. Reviewed `innerHTML` assignments were fed by fixed catalogs, escaped syntax-highlighting output, or server-sanitized cached HTML. No stored or reflected XSS payload was reproduced in the reviewed paths.

### Collaboration and WebSockets

WebSocket upgrades enforce the configured origin. Collaboration uses short-lived, purpose-specific tickets with fixed claims, checks access again at connection and persistence boundaries, limits frames and document state, and protects materialization against stale room writers. No unauthenticated room join, cross-page ticket reuse, or obvious resource-limit bypass was reproduced.

### Secrets and Git history

The working tree and approximately 1,367 Git blobs were checked for obvious private keys, common cloud/API token formats, and credential-assignment patterns. No likely committed secret was identified by those pattern checks. Pattern scanning cannot prove that every possible proprietary or low-entropy credential is absent.

## Validation Results

The final source tree was validated with:

- Lockfile registry and dependency-version assertions
- Security-hardening source verifier
- Collaboration source verifier and JavaScript syntax scan
- Data-loss guard verifier
- Focused remediation regression tests
- All dependency-free `tests/*.node.test.mjs` tests
- Targeted JavaScript and TypeScript syntax checks
- Exact CSP import-map SHA-256 verification
- `.git` byte-manifest comparison against the extracted baseline

The dependency-free Node suite completed with **85 passing tests and 0 failures** before final packaging. The focused remediation file completed with **3 passing tests and 0 failures** and is also invoked by `npm run verify:security`.

A full `npm ci`, `npm audit`, TypeScript build, Vitest suite, MariaDB integration run, and browser-driven collaboration session could not be completed in the analysis container because the configured package-registry path did not provide every locked package and direct public-registry DNS resolution was unavailable. This is an environment limitation, not a passing result. The source and lockfile checks above were therefore supplemented with public advisory and package-metadata verification.

## Files Changed

- `SECURITY_REVIEW.md`
- `package.json`
- `package-lock.json`
- `src/app.ts`
- `public/index.html`
- `public/collaboration.js`
- `tests/security-remediation.node.test.mjs`
- `tests/collaboration-ui.test.ts`
- `scripts/verify-security-hardening.mjs`
- `scripts/verify-collaboration.mjs`
- `docs/collaboration/2026-07-29/collaboration.md`
- `docs/configuration/2026-07-28/configuration.md`

No separate raw audit-log file was added.

## Deployment Follow-Up

Before production release, run the following from a network that can access the lockfile registry and from an integration environment with the production MariaDB major version:

```bash
npm ci
npm audit --omit=dev
npm run check
npm run verify:security
npm run verify:collaboration
npm run verify:data-loss
```

Also verify the real reverse-proxy trust boundary, HTTPS redirect behavior, `PUBLIC_ORIGIN`, `CORS_ORIGIN`, WebSocket upgrades, cookie flags, upload/body limits, database permissions, backup storage permissions, and restore recovery behavior under the exact production topology.

The remaining KaTeX resources are exact-version jsDelivr paths and the script uses Subresource Integrity. Self-hosting those static assets would further reduce third-party availability and supply-chain exposure, although it was not classified as an urgent vulnerability in this review.

## Repository Preservation

The supplied `.git` directory is retained in the remediated archive. It was compared by path, size, mode-relevant file content, and SHA-256 manifest against the extracted baseline before packaging. The original working-tree line-ending state was not reset or normalized.
