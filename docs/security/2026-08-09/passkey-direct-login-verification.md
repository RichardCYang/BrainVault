# Direct passkey-login security and reproducibility verification

Date: 2026-08-09

## Executive conclusion

BrainVault now supports username-less, passwordless sign-in from the login screen with a discoverable WebAuthn credential. The implementation reuses the existing per-account passkey records but adds a separate anonymous ceremony boundary, one-time challenge storage, an `HttpOnly` browser-binding cookie, exact origin and RP-ID verification, mandatory user verification, required `userHandle` account binding, strict canonical input handling, and transactionally protected counter updates.

No exploitable issue was found in the defined threat model after the independent cryptographic reproduction, source-invariant checks, and included route/UI integration tests described below. This is evidence for the tested implementation and environment, not a claim that any authentication system can be proven absolutely free of all present or future vulnerabilities.

## Standards basis

The design follows these primary references:

- [W3C Web Authentication: Level 3](https://www.w3.org/TR/webauthn-3/): a discoverable credential is usable when the RP supplies no credential IDs; discoverable credentials carry a populated user handle; credential IDs are at most 1023 bytes; RP operations must bind credentials to an RP ID and use HTTPS or an equivalent secure transport.
- [SimpleWebAuthn passkey guidance](https://simplewebauthn.dev/docs/advanced/passkeys): username-less sign-in uses an empty `allowCredentials` list, anonymous challenges should be associated with an `HttpOnly` session identifier, and the challenge must be deleted or otherwise made unusable even when verification fails.
- [SimpleWebAuthn server guidance](https://simplewebauthn.dev/docs/packages/server): authentication verifies the expected challenge, origin, RP ID, and credential, then persists the returned signature counter.
- [Node.js July 29, 2026 security release](https://nodejs.org/en/blog/vulnerability/july-2026-security-releases): the project runtime floor includes Node.js 22.23.2, 24.18.1, and 26.5.1 because the release fixes active-line HTTP, HTTP/2, permission-model, TLS, DNS, zlib, Undici, and llhttp security issues.

## Authentication flow

1. The browser sends an empty JSON object to `POST /api/auth/passkey/options` from an allowed exact origin.
2. The server issues WebAuthn authentication options with `allowCredentials: []` and `userVerification: "required"`.
3. Independently of the WebAuthn challenge, the server creates a 256-bit opaque one-time token. Only its SHA-256 hash is stored.
4. A separate 256-bit browser binding is placed in a `SameSite=Strict`, `HttpOnly`, `Secure` `__Host-` cookie in HTTPS deployments. Only its SHA-256 hash is stored with the challenge.
5. The browser asks the authenticator for a discoverable credential and submits the assertion to `POST /api/auth/passkey/verify`.
6. The server atomically consumes the challenge before parsing the full assertion, so malformed, forged, and corrected replay attempts cannot reuse it.
7. The server requires canonical base64url, byte-identical `id` and `rawId`, a populated `userHandle` matching the stored account handle, the exact expected challenge/origin/RP ID, user presence, user verification, a valid signature, and a non-regressing signature counter where the authenticator uses counters.
8. The user and credential are locked in one database transaction. Security-relevant credential fields must still match the verified snapshot, and the counter update uses compare-and-swap semantics.
9. A successful login resets password-failure backoff, records the login, signs the current authentication generation, and sets the existing `HttpOnly` session cookie. No JWT is returned in JSON.

## Security invariants

- **No account identifier is accepted by the options route.** The empty request body prevents account enumeration through option generation.
- **The anonymous challenge is browser-bound and one-shot.** A copied token without its unique `HttpOnly` binding cookie fails. A token is consumed even when the remaining assertion is malformed.
- **Requests are fail-closed.** The anonymous passkey route has a 64 KiB parser limit. The envelope, credential, and authenticator-response objects use exact key sets independently of Zod. Credential IDs, user handles, signatures, authenticator data, client data, and extension results have explicit length, depth, and node limits.
- **The account comes from authenticated credential material.** The server looks up the credential ID, then requires the signed discoverable-credential `userHandle` to match that credential's stored WebAuthn user ID before creating a session.
- **Origin and RP scope are server-authoritative.** The response is checked against configured exact origins and the configured RP ID; browser-supplied values never select them.
- **User verification is mandatory.** Both option generation and response verification require UV, allowing the passkey to serve as the passwordless primary authentication ceremony.
- **Credential state cannot be silently swapped during verification.** The transaction re-locks the credential, compares its ID, owner, credential ID, user handle, public key, and counter with the verified snapshot, and applies a counter compare-and-swap update.
- **Failure responses do not identify the account.** Unknown credential, wrong user handle, bad signature, wrong origin/RP ID, replay, and counter failures use the same `401 PASSKEY_LOGIN_FAILED` response.
- **New credentials are discoverable.** Registration now requires `residentKey: "required"`; older non-discoverable credentials may still work for the existing account-selected MFA flow but must be re-registered before they can appear in username-less login.

## Reproducible attack matrix

Run:

```bash
npm run reproduce:passkey-direct-login
```

The script uses only Node.js built-ins. It creates a real P-256 key pair, serializes an ES256 COSE public key, constructs authenticator data and `clientDataJSON`, signs the WebAuthn assertion, verifies the signature, advances the counter, and then repeats the ceremony with adversarial mutations.

Expected report schema version: `2`.

| Reproduction | Expected result |
| --- | --- |
| Valid P-256 assertion | Accepted; counter advances |
| Exact replay | Generic rejection |
| Challenge token copied without binding cookie | Generic rejection |
| Malformed response followed by corrected replay | Both requests rejected |
| Unexpected nested assertion field | Generic rejection |
| Wrong browser origin | Generic rejection |
| Wrong RP-ID hash | Generic rejection |
| Missing user-verification flag | Generic rejection |
| Wrong `userHandle` | Generic rejection |
| Different `id` and `rawId` | Generic rejection |
| Non-advancing signature counter | Generic rejection |
| Tampered signature | Generic rejection |
| Invalid challenge-token shape | Generic rejection |
| Oversized extension results | Generic rejection |
| Unknown credential | Generic rejection |
| Credential public key changed before commit | Generic rejection |

The same script checks 18 implementation invariants, including discoverable options, mandatory UV, exact origin/RP ID, one-time consumption, cookie binding, canonical credential boundaries, exact JSON keys, client-extension bounds, the 64 KiB anonymous request limit, user-handle binding, stable credential commit, generic failures, bounded anonymous storage, browser user-handle serialization, and discoverable registration.

Additional dependency-backed tests are included in:

- `tests/passkey-direct-login.routes.test.ts`: real P-256 assertions through the Express route with a stateful database double, including cookie binding, replay, origin, RP ID, UV, user handle, credential ID, counter, extension, nested-key, 64 KiB body, unknown-credential, session-cookie, lockout-reset, login-history behavior, and confirmed zero-change writes from legitimate counterless authenticators.
- `tests/passkey-direct-login-ui.test.ts`: login-screen markup, localization, and browser ceremony wiring.
- `tests/passkey-direct-login-security.node.test.mjs`: dependency-free source contracts plus execution of the standalone reproduction.

## Verification commands

Use a patched runtime accepted by `package.json`, preferably Node.js 24.18.1 or newer in the supported ranges:

```bash
npm ci
npm run lockfile:check
npm run build
npm run test:security
npm run verify:security
npm run test:durability
npm run reproduce:passkey-direct-login
```

The standalone reproduction and Node test are intentionally dependency-free and can also be run directly:

```bash
node scripts/reproduce-passkey-direct-login.mjs
node --experimental-strip-types --test tests/passkey-direct-login-security.node.test.mjs
```

## Verification performed for this delivery

The final modified source tree was checked on the supplied sandbox with Node.js 22.16.0 for dependency-free checks. Every command that can execute without installing third-party packages passed:

| Check | Result |
| --- | --- |
| `npm run lockfile:check` | **PASS**; 346 approved lockfile URLs |
| `npm run verify:security` | **PASS**; 48/48 tests |
| `npm run test:durability` | **PASS**; 219/219 tests |
| `npm run verify:data-loss` | **PASS** |
| `npm run verify:collaboration` | **PASS**; source and syntax verification for 312 files |
| `npm run reproduce:passkey-direct-login` | **PASS** |
| Real-cryptography assertions | **3/3 PASS** |
| Adversarial reproductions | **15/15 PASS** |
| Static passkey security contracts | **18/18 PASS** |
| Dependency-free passkey Node tests | **3/3 PASS** |
| Changed-source parser checks plus package JSON/OpenAPI parsing | **16/16 PASS** |

The standalone reproduction uses a real P-256 key pair and signature rather than a mocked verification result. It accepted the valid assertion and rejected all modeled replay, cookie-copy, malformed-then-corrected replay, unexpected-field, wrong-origin, wrong-RP-ID, missing-UV, wrong-user-handle, credential-ID mismatch, counter-regression, signature-tampering, malformed-token, oversized-extension, unknown-credential, and credential-state-race cases.

The supplied sandbox's Node.js 22.16.0 is below this repository's enforced minimum of 22.23.2. The official Node.js 24.18.1 release page and SHA-256 list were verified, but the execution environment blocked downloading the Linux archive by compressed MIME type. A normal `npm ci` therefore correctly stopped with `EBADENGINE`. A diagnostic retry with only `engine-strict` disabled then stopped because the sandbox package gateway returned `404` for the lockfile-pinned `zod@3.25.76`; direct public-registry DNS resolution was unavailable. Consequently, this sandbox could not honestly claim a clean dependency install, TypeScript build, or Vitest execution. The dependency-backed route/UI tests remain included and must run in CI or deployment on a supported patched runtime.

## Deployment requirements

1. Apply migration `040_passkey_direct_login.sql` before enabling the updated application.
2. Deploy on a supported patched Node.js version and run the full command set above with a clean `npm ci`.
3. Use HTTPS in production. Set `PUBLIC_ORIGIN`, `WEBAUTHN_ORIGIN`, `CORS_ORIGIN`, and `WEBAUTHN_RP_ID` to the exact intended deployment boundary.
4. Keep the backend private behind the configured trusted proxy, or use direct TLS. Do not expose a proxy-mode HTTP listener directly.
5. The built-in `express-rate-limit` stores are process-local. A multi-instance deployment must enforce equivalent passkey options/verification limits at the edge or use a shared limiter store.
6. Ask users whose older passkeys do not appear in username-less selection to remove and re-register them; new registration requires a discoverable credential.
7. Treat direct passkey login as a primary authentication path. A registered passkey with local user verification can complete login without the password/TOTP sequence, by design.
8. Preserve database backups and test account recovery before changing RP ID or origin settings; WebAuthn credentials are scoped to the RP boundary.

## Source-archive integrity

The input archive contained 44 `.git` entries. The canonical archive fingerprint below is SHA-256 over each sorted `.git` entry's UTF-8 path, a NUL byte, its raw uncompressed bytes, and a trailing NUL byte:

```text
e8012e5a071cb69034747a51cc51cc7f40fb2ca2105cd1da296de50bae18a577
```

The delivery archive is built by copying every `.git` entry directly from the original ZIP rather than regenerating it. Packaging verification compares the complete sorted entry list and every entry's uncompressed bytes, then recomputes the same fingerprint after safe extraction.

## Delivery verification log

```text
Pre-package source checks:                    PASS (8/8 command groups)
Lockfile policy:                              PASS (346 approved URLs)
Repository security tests:                    PASS (48/48)
Repository durability tests:                  PASS (219/219)
Data-loss guard verification:                 PASS
Collaboration verification:                   PASS (312 source files)
Direct-passkey real-crypto checks:             PASS (3/3)
Direct-passkey modeled attacks:                PASS (15/15)
Direct-passkey static security contracts:      PASS (18/18)
Direct-passkey dependency-free Node tests:     PASS (3/3)
Changed source / JSON / OpenAPI parser checks: PASS (16/16)
Dependency install / build / Vitest:           NOT EXECUTED; sandbox runtime and package gateway limitations documented above
Delivery ZIP CRC / duplicate / path checks:     PASS
Delivery worktree byte comparison:              PASS (433/433 files)
Preserved .git per-entry byte comparison:       PASS (44/44 entries)
Preserved .git archive fingerprint:             e8012e5a071cb69034747a51cc51cc7f40fb2ca2105cd1da296de50bae18a577
Safe extraction and extracted .git comparison:  PASS
Re-extracted delivery Git object verification:   PASS (`git fsck --full --no-reflogs`)
Re-extracted delivery command groups:            PASS (10/10)
```
