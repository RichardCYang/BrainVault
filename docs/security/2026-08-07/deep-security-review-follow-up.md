# Deep Security Review Follow-up

**Review date:** 2026-08-07  
**Project:** BrainVault  
**Scope:** Server, browser client, authentication and MFA, authorization, collaboration WebSockets, attachment and backup handling, bookmark fetching, deployment configuration, dependency lockfile, and dependency-free regression tests.

## Executive summary

No unauthenticated remote-code-execution path, SQL injection, direct authentication bypass, cross-user page mutation, persistent executable XSS path, or private-network bookmark SSRF was reproduced in the reviewed source. The existing controls around session revocation, MFA attempt reservation, collaboration tickets, page authorization, attachment storage, backup validation, output encoding, and request resource limits were retained.

One deployment-boundary weakness was reproduced and remediated: numeric reverse-proxy hop trust could accept attacker-controlled forwarding headers when the application backend was reachable through a shorter path than the configured topology. In that condition, a direct client could make Express treat a plaintext request as HTTPS and influence proxy-derived client IP handling. The risk depended on an unsafe deployment path, but the application configuration made the failure mode possible.

## Finding BV-2026-08-07-01: numeric reverse-proxy trust

**Severity:** High when the backend listener is directly or inconsistently reachable; otherwise configuration-dependent.

### Reproduction

The retired decision model treated every direct peer as trusted whenever `TRUST_PROXY_HOPS` was positive. A request from an arbitrary remote address with `X-Forwarded-Proto: https` therefore passed the raw collaboration upgrade HTTPS check. Express numeric trust can similarly select a client-supplied `X-Forwarded-For` value when a path contains fewer hops than expected.

The regression test `tests/reverse-proxy-trust-boundary.node.test.mjs` reproduces the retired decision and verifies that the remediated implementation rejects it:

```sh
node --experimental-strip-types --test tests/reverse-proxy-trust-boundary.node.test.mjs
```

### Remediation

- `TRUST_PROXY_HOPS` is retained for configuration compatibility but must remain `0`.
- Proxy mode now requires `TRUST_PROXY_ADDRESSES`.
- Catch-all `/0` proxy CIDRs are rejected.
- Express proxy trust is configured only from explicit IP, narrow CIDR, or named peer rules.
- HTTP middleware and raw collaboration WebSocket upgrades independently verify the directly connected proxy address before accepting `X-Forwarded-Proto`.
- Forwarded protocol parsing accepts only one canonical `http` or `https` value; duplicate, array, comma-delimited, and other values fail closed.
- Production now refuses `HTTPS_MODE=off`; it requires reverse-proxy TLS or direct Posh-ACME TLS.

## Dependency review

The lockfile pins `multer` 2.2.0, `sanitize-html` 2.17.5, and `express-rate-limit` 8.5.2. These versions are at or above the patched releases for the reviewed 2026 multipart denial-of-service, sanitizer bypass, and IPv4-mapped IPv6 rate-limit advisories. The application also sets `fieldNestingDepth` to `1`, applies multipart count and size limits, sanitizes rendered Markdown, and uses bounded request processing.

This was a lockfile and source review rather than a live registry audit because package-registry access was unavailable in the review environment.

## Verification performed

The following dependency-free checks completed successfully after remediation:

```sh
npm run lockfile:check
npm run verify:security
npm run verify:data-loss
npm run verify:collaboration
node --experimental-strip-types --test tests/*.node.test.mjs
```

The complete dependency-free Node.js test suite passed **200 of 200 tests**. The installed TypeScript compiler API parsed **157 TypeScript files** with zero syntax diagnostics, and a targeted strict type check passed for the modified reverse-proxy and HTTPS middleware modules.

## Verification limitations

A clean dependency installation and the full Vitest/build/database integration suite could not be completed in the review environment because the configured package mirror did not provide a locked dependency and outbound package-registry access was unavailable. The available Node.js runtime was also below the security floor declared by the project. These environmental limits do not invalidate the source-level reproduction or dependency-free regression coverage, but production deployment should still run `npm ci` and `npm run check` on a supported Node.js release with MariaDB available.

## Residual operational requirements

- Keep the backend listener private and reachable only by the configured proxy peers.
- Prefer exact proxy IP addresses over broad named ranges or CIDRs.
- Strip and replace forwarding headers at the edge proxy rather than appending untrusted client values.
- Keep registration disabled unless intentionally required, use unique production secrets, and run on a Node.js version allowed by `package.json`.
- Treat local browser profiles as trusted device storage because unsynchronized drafts may remain locally for recovery.

This review reduces known risk but is not a guarantee that the application is vulnerability-free. Security testing should be repeated after material authentication, sharing, parser, dependency, or deployment changes.
