# Direct passkey login prompt latency analysis and remediation

Date: 2026-09-02

## Scope

This review targets the login-screen **Sign in with a passkey** path (`POST /api/auth/passkey/options` -> `navigator.credentials.get()` -> `POST /api/auth/passkey/verify`). The cryptographic verification, browser-bound ceremony cookie, one-time challenge consumption, user-handle binding, RP/origin checks, user verification, and counter protections are intentionally unchanged.

## Root cause

The browser cannot open its native WebAuthn/passkey UI until it has a server-generated challenge. Standards discussion around a proposed WebAuthn `challengeUrl` explicitly calls out this fetch as extra latency that delays credential UI. BrainVault's direct-login path amplified that unavoidable network dependency in two ways:

1. **The click handler waited for the options request before invoking WebAuthn.** Even after the previous STUN/WebRTC wait was removed, the path was still click -> HTTP -> server/DB -> HTTP -> `navigator.credentials.get()`. Any transient network or DB latency directly became passkey-dialog latency. The asynchronous gap also meant the native call no longer happened in the original click task.
2. **The options endpoint performed unrelated garbage collection inside a transaction before replying.** Challenge issuance ran `SET TRANSACTION`, `BEGIN`, an expired-row `DELETE`, the challenge `INSERT`, and `COMMIT`. Cleanup is independent of issuing the new challenge, so these extra DB protocol operations were unnecessary in the prompt-critical path. The `used_at <= now - 10m` cleanup arm was also redundant because every challenge already expires after five minutes.

There is a third residual layer that application code cannot eliminate: browser/OS/passkey-provider startup and credential enumeration. WebKit has documented intermittent cases where `navigator.credentials.get()` hangs or delays independently of site logic. The changes below remove BrainVault-controlled latency before that native boundary; they cannot make a browser/OS authenticator implementation deterministic.

## Remediation

### 1. Intent-based option warm-up

`public/app.js` now prepares direct-login options when the user demonstrates intent through `pointerenter`, `pointerdown`, or keyboard focus on the passkey button. A successful warm-up is cached for only 45 seconds.

The warm-up is deliberately **not** started on every anonymous page load. BrainVault rate-limits username-less passkey option issuance (default 30 requests per IP per 15 minutes), so unconditional page-load prefetching could waste rate-limit budget for users who never choose passkeys or for many users behind the same NAT.

When the warm-up has completed before the click, the click handler takes the already-issued options and reaches `navigator.credentials.get()` without an earlier `await`. This keeps the native WebAuthn hand-off in the trusted click task and removes the challenge network round trip from the visible click-to-dialog path.

If warm-up has not completed, the handler waits for the in-flight request or performs the normal request, preserving behavior for touch/network timing where no head start was available.

### 2. Prompt-critical DB path reduced to one insert

`src/routes/passkey-login.routes.ts` now performs only the challenge `INSERT` before returning `/api/auth/passkey/options`.

Expired-challenge cleanup is best-effort, rate-limited to at most once per minute per process, and scheduled from the HTTP response `finish` event so it starts only after the options response has been handed off. Verification remains fail-closed because every challenge lookup already requires `expires_at > CURRENT_TIMESTAMP(3)`.

Cleanup now uses only the existing indexed `expires_at` predicate. This preserves storage cleanup without making native prompt presentation wait on unrelated row deletion or transaction setup/commit.

## Why Chrome Immediate UI was not forced

Chrome 149 introduced `uiMode: "immediate"`, but Chrome's documentation states that, as of May 2026, it is Chrome-only and rejects with `NotAllowedError` when no eligible credential is locally available. BrainVault supports cross-device/hybrid and other standard WebAuthn paths, so forcing Immediate UI on the dedicated button could regress users whose usable passkey is on another device/provider. The remediation therefore optimizes the standards-compatible WebAuthn flow instead of changing credential-selection semantics.

## Security invariants retained

- Server-generated random challenge and opaque token.
- HttpOnly, SameSite=Strict browser ceremony binding.
- One-time challenge consumption before full assertion validation.
- `allowCredentials: []` discoverable-credential login with required user verification.
- Exact expected origin and RP ID.
- Required signed `userHandle` match to the stored WebAuthn user ID.
- Canonical credential ID boundaries and strict response shape.
- Credential-state recheck and signature-counter protection.
- Expired challenges are rejected regardless of cleanup timing.

## Verification performed in the supplied sandbox

- `node --check public/app.js`: PASS.
- `node --experimental-strip-types --check src/routes/passkey-login.routes.ts`: PASS.
- `node --experimental-strip-types --test tests/passkey-direct-login-security.node.test.mjs`: PASS (3/3).
- `npm run reproduce:passkey-direct-login`: PASS; valid P-256 assertion accepted, all 15 modeled attacks rejected, all 18 static security contracts passed.
- `npm run lockfile:check`: PASS; 346 approved lockfile URLs.
- Full dependency installation was attempted with the repository's engine restriction overridden only for sandbox verification, but the sandbox could not resolve `registry.npmjs.org` (`EAI_AGAIN`). Therefore Vitest/TypeScript dependency-backed suites could not be honestly executed here.

## References reviewed

- W3C Web Authentication Level 3: https://www.w3.org/TR/webauthn-3/
- W3C WebAuthn issue discussion for `challengeUrl` and challenge-fetch UI latency (issue 2152)
- MDN User Activation API: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/userActivation
- Chrome Immediate UI mode: https://developer.chrome.com/docs/identity/immediate-ui-mode
- WebKit bug 273712, intermittent WebAuthn/passkey hangs: https://bugs.webkit.org/show_bug.cgi?id=273712
