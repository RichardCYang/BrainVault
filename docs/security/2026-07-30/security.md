# Security

## Passwordless passkey login

The sign-in screen can authenticate directly with a discoverable WebAuthn credential, without first accepting an ID or password. The anonymous options route returns an empty `allowCredentials` list and requires user verification. Its one-time challenge is stored only by hash, bound to a separate `HttpOnly`, `SameSite=Strict` ceremony cookie, expired after five minutes, and atomically consumed before the full assertion is parsed so a malformed attempt cannot be corrected and replayed.

Verification requires canonical and byte-identical `id`/`rawId` values, the credential's populated `userHandle`, the configured exact origin and RP ID, user presence and user verification, a valid signature, and a non-regressing counter where counters are supported. The transaction re-locks both the account and credential, verifies that the credential's security fields have not changed since signature verification, and updates the counter with compare-and-swap semantics. Unknown credentials, wrong handles, cryptographic failures, and replay return the same generic error. New passkey registration requires `residentKey: "required"`; an older non-discoverable passkey may need to be re-registered before it appears in direct login.

The anonymous passkey body is limited to 64 KiB and uses exact object key sets plus explicit base64url, extension-result, depth, and node bounds. Options and verification have separate IP rate limits. Those stores are process-local, so horizontally scaled deployments must apply equivalent edge limits or a shared store. See [Direct passkey-login security and reproducibility verification](../2026-08-09/passkey-direct-login-verification.md) for the threat model, attack matrix, and commands.

## Two-step verification

Open **Settings → Security** to configure either verification method:

- **Authenticator app (TOTP):** BrainVault displays a QR code and manual setup key, then enables the method only after a valid six-digit code is confirmed. The stored TOTP secret is encrypted with AES-256-GCM, and a code cannot be replayed within the same time step.
- **Passkeys (WebAuthn/FIDO2):** Add, name, rename, and remove multiple platform passkeys or external hardware security keys. Each credential is stored separately so a primary device and recovery keys can coexist.

After the password is accepted, accounts with at least one configured method receive a short-lived, one-time MFA session instead of a JWT response. Completing an available TOTP or passkey challenge creates the normal `HttpOnly`, `SameSite=Strict` session cookie. The cookie is marked `Secure` whenever the configured public origin or HTTPS mode uses TLS. Authentication responses do not include the JWT in JSON, and the built-in browser client does not persist session credentials in Web Storage. Compatibility bearer sessions are disabled by default in production and remain subject to browser-origin checks when explicitly enabled.

Local WebAuthn development works at `http://localhost:4000`. Production deployments should use HTTPS and set `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` to the exact relying-party domain and browser origin.

Changing `MFA_ENCRYPTION_KEY` after users enroll TOTP invalidates their encrypted authenticator secrets. Store and rotate it through a managed secret process.

## Secret generation and startup guards

`npm run env:init` generates independent cryptographically random values for the MariaDB application password, `JWT_SECRET`, and `MFA_ENCRYPTION_KEY`; it never copies usable public secrets from the example file. `npm run secrets:generate` prints separate 32-byte (256-bit) base64url values for the JWT and MFA settings. Add `-- --write` to fill missing or generated-placeholder assignments in an existing `.env`; existing real values are protected unless `--force` is also supplied. Treat forced MFA-key replacement as a managed migration because existing enrolled TOTP secrets become unreadable. `DATABASE_URL` must contain a non-empty password and known public/default values are rejected. Production requires both cryptographic variables explicitly. Known placeholders, legacy development values, and reuse of one cryptographic value for both purposes are rejected at startup. When no cryptographic secret is configured outside production, BrainVault uses per-process ephemeral values rather than a shared repository constant.

The HTTP server binds to `127.0.0.1` by default. External binding requires an explicit `HOST` setting.

## Runtime security baseline

Dependency installation is blocked on Node.js releases older than the July 29, 2026 security updates. Supported floors are Node.js 22.23.2 within the 22.x line, Node.js 24.18.1 within the 24.x line, or Node.js 26.5.1 and newer. The package engine range is mirrored in the lockfile, and `.npmrc` enables `engine-strict=true` so `npm install` and `npm ci` fail instead of merely warning on an older runtime.

These versions include the Node.js fixes for the HTTP/2 memory-exhaustion and use-after-free issues, permission-model boundary defects, HTTPS identity/session-reuse issues, DNS and zlib denial-of-service conditions, request-header desynchronization, and the bundled Undici/llhttp updates announced in the July 2026 security release. Production images and CI runners should pin a current patched release rather than relying only on the minimum range.

When `MARIADB_ADMIN_URL` is used, bootstrap creates application accounts only for the exact hosts in `DB_USER_HOSTS`, refreshes their passwords with `ALTER USER`, grants only the schema privileges needed by BrainVault, and removes the legacy `brainvault@'%'`-style wildcard account. Existing deployments should rerun `npm run db:init` with an administrator connection after choosing a new database password and exact account hosts.

## Authenticated response cache isolation

Every request that crosses the `requireAuth` boundary receives `Cache-Control: private, no-store` before credential parsing, database access, or route execution. This protects cookie-authenticated API JSON, authenticated errors, data exports, attachments, and optional internal documentation from browser or intermediary reuse. The internal documentation static handler disables its own cache metadata so it cannot replace the authentication-boundary policy.

The custom page-cover binary endpoint is the only deliberate exception. It remains private, uses immediate revalidation, and varies on both `Cookie` and `Authorization` so an unchanged image can be conditionally reused only within the matching credential context.

## Authentication abuse controls

Login is protected by IP-keyed and normalized-account-keyed request limits plus a database-persisted account backoff. Password failures are updated under a user-row lock; after the configured threshold, the lock duration grows exponentially up to the configured maximum, so distributed source IPs cannot reset the account state. A correct password clears a persisted lock and failure counter, preventing a low-rate attacker from keeping an account unavailable indefinitely; the account must still complete any configured MFA challenge. Attempts rejected solely because the account is still locked are recorded as `LOCKED`, not as ordinary credential failures. A password-valid response that still requires MFA is counted rather than treated as a completed successful login. TOTP and passkey login verification have separate IP and account limits, and the short-lived MFA login token is bound to the source IP that created it. TOTP enrollment verification has its own account limit, and the enrollment code's time step is stored immediately so the same code cannot be reused for login. MFA failures are carried into replacement login sessions under a user-row lock, so signing in again cannot reset the eight-attempt session budget. Successful MFA completion clears the carried state. Registration has per-IP and process-wide limits, defaults to disabled in production, avoids repeated password hashing for an existing username, and returns the same padded accepted response. When public registration is enabled, combining registration and login behavior may still reveal whether a normalized login ID exists; production should keep registration disabled unless open enrollment is intentional. The in-memory request limiters are suitable for one process; multi-instance deployments should use a shared rate-limit store, while the password backoff remains shared through MariaDB.

## Credential-change session revocation

API access tokens and page-scoped collaboration tickets use separate JWT audiences, a fixed HS256 algorithm, and the `brainvault` issuer. Session tokens default to 12 hours and configuration rejects lifetimes longer than 24 hours. Tokens also carry the account's current authentication generation. Changing the password or logging out increments that generation, deletes unfinished MFA and WebAuthn login state, and immediately closes local collaboration sockets. The initiating browser receives a replacement cookie after a password change; logout clears the cookie. Older API tokens, collaboration tickets, and periodically rechecked sockets fail closed.

The `024_auth_session_revocation.sql` migration adds the non-secret `users.auth_version` generation counter. Deploying this version invalidates legacy JWTs that do not contain the strict issuer, audience, and generation claims, so users should expect to sign in again once after the upgrade.

## Browser origin policy

Production refuses to start unless `HTTPS_MODE` is `proxy` or `posh-acme`, and `PUBLIC_ORIGIN` must be HTTPS. Every browser origin, including development loopback origins and ports, must be listed explicitly in `CORS_ORIGIN`. API CORS and collaboration WebSocket origin checks never derive authorization from `X-Forwarded-Host` or `X-Forwarded-Proto`. In `HTTPS_MODE=proxy`, forwarding headers are accepted only when the directly connected peer matches `TRUST_PROXY_ADDRESSES`; numeric hop trust and catch-all `/0` CIDRs are rejected, and comma-delimited or duplicate forwarded-protocol values fail closed. In `HTTPS_MODE=posh-acme`, BrainVault validates the configured certificate against `PUBLIC_ORIGIN` and creates a native TLS listener without trusting forwarding headers. Redirect destinations always use fixed `PUBLIC_ORIGIN`, not a request header. Unrestricted boolean proxy trust is not used.


## Rendered HTML restrictions

Sanitized note HTML permits embedded video frames only from the supported YouTube hosts. User-supplied iframe permission attributes are removed, and input elements are retained only for disabled checkbox rendering; password and other interactive input types are discarded.

## Content Security Policy

The Content Security Policy allows only same-origin application scripts plus the exact versioned KaTeX and Yjs resources used by the current client. It does not trust the complete jsDelivr host. WebSocket destinations are derived from the exact configured browser origins rather than allowing every `ws:` or `wss:` endpoint. Dynamic page-render attributes are escaped, collaboration block IDs use the same restricted identifier alphabet as backup data, and client-side attribute selectors use `CSS.escape()`.

## Bookmark preview safety

Browser cross-origin rules prevent the editor from reading arbitrary page HTML directly, so OpenGraph retrieval uses the authenticated `/api/bookmarks/preview` server endpoint. Server-side preview fetches permit only the configured destination ports (80 and 443 by default), require an explicit HTML content type, pin validated public DNS answers to the outbound request, and revalidate every redirect. Blocked private-network targets and ordinary remote fetch failures return the same recoverable warning shape so the endpoint does not expose a useful internal-DNS or port oracle.

Stored bookmark, image, and favicon URLs reject private or local IP literals before they can be rendered into another viewer's browser. Hostnames that later resolve to a private address cannot be rejected by this synchronous storage validation; operators should treat internal DNS names as sensitive, while the server-side preview path continues to perform full DNS validation and pinning.

The fetcher:

- Accepts only public HTTP(S) destinations
- Revalidates every redirect
- Rejects local, private, and reserved IP ranges
- Pins validated DNS results
- Allows Node.js to fall back between IPv4 and IPv6 connection attempts
- Reads only the document head up to the configured byte limit
- Supports common legacy page character sets

A dedicated authenticated-user limiter bounds how often this server-side fetch path can be invoked. Use `BOOKMARK_PREVIEW_WINDOW_MS` and `BOOKMARK_PREVIEW_MAX` for that limit, and `BOOKMARK_FETCH_TIMEOUT_MS` and `BOOKMARK_FETCH_MAX_BYTES` for each fetch.

## Page version-history privacy

Page version history can contain complete snapshots of deleted blocks. List, detail, and reset operations are therefore owner-only, and the browser hides the version-history action from invited editors. Normal page and collaboration access remains available to editors; only the historical snapshot store is restricted.

## Shared-page collaboration safety

Only a page owner can create or remove editor grants. Session issuance, WebSocket upgrade, periodic live-connection checks, relational materialization, attachment access, and normal page reads each re-check the authenticated user’s owner/editor access. Direct REST attachment creation is rejected after a page enters collaboration, matching the direct block-mutation invariant and preventing an out-of-band relational write. Removing a grant closes that user’s sockets immediately; archiving or deleting the page closes the room.

Collaboration tickets are short-lived, page-scoped JWTs sent in the WebSocket subprotocol rather than the URL. The server validates browser origin, RFC 6455 framing and masking, frame/message size, update rate, current page state, and the ticket’s user/page scope. Accepted binary updates are committed to MariaDB before acknowledgement and broadcast. Every write also compares the process-local room tip with the locked durable update tip; a room that missed another process's update is invalidated before insertion or compaction.

A client cannot create an attachment merely by inserting Yjs metadata. New attachment blocks must come from the authenticated upload endpoint, and relational materialization preserves or validates canonical file metadata. Snapshot validation also rejects duplicate/global block IDs, missing parents, cycles, excessive nesting, stale update markers, replaced document epochs, and title/block limits. Session tickets, WebSocket rooms, database writes, and browser recovery records carry the same epoch so an offline pre-restore Yjs document cannot be replayed into a newly initialized page with the same page ID. Session issuance requires the generation-aware client protocol marker, which prevents already-open pre-fix tabs from reconnecting with legacy recovery behavior after a deployment.

For an attachment that already exists in the collaboration document, its parent and order come from the acknowledged Yjs state rather than the potentially lagging relational session snapshot. The SQL snapshot remains authoritative for immutable file identity and metadata, and is used for position only when the attachment is genuinely missing from Yjs. Collaboration protocol version 2 and WebSocket subprotocol `brainvault-yjs-v2` reject cached pre-fix writers during deployment.

See [Collaboration](../../collaboration/2026-07-29/collaboration.md) for the complete access and persistence model.

## Untrusted code rendering

Highlight.js grammars execute regular expressions synchronously. BrainVault therefore highlights at most 2,000 UTF-16 code units per untrusted code block on both the server and browser. Server rendering runs the grammar inside a Node.js VM invocation with a 25 ms execution deadline. Longer inputs, unknown grammars, errors, or timeouts preserve the complete source as HTML-escaped plain text instead of dropping or truncating note content.

Initial browser hydration is additionally limited to 20 blocks and 8,000 aggregate code units per render pass. These controls apply to editor previews, Markdown fences, read-only rendering, backup restoration, and collaboration materialization paths that can encounter stored code.

## Attachment safety

Uploaded bytes are stored under `ATTACHMENT_UPLOAD_DIR`, which defaults to `uploads/` at the project root. This directory is ignored by Git and is never mounted as a public static directory.

Upload validation rejects active web and executable extensions and media types, detects executable signatures, verifies signatures for formats that have stable magic bytes, and downgrades unrecognized client-declared media types to `application/octet-stream`. Client `Content-Type` is never accepted as the only trust signal. Existing legacy metadata is also normalized at download time, and active legacy filenames receive a neutral `.download` suffix.

Before multipart bytes are accepted, the upload route verifies current page access, rejects shared or archived targets, checks the declared request size when available, applies a dedicated per-account rate limit, and admits at most one active upload per account within a bounded process-wide concurrency pool. The transaction repeats the authorization and page-state checks after intake so access revocation, sharing changes, and archive changes fail closed. These admission controls are process-local; multi-instance deployments must enforce equivalent shared limits at the proxy or with a distributed store.

Every download goes through `/api/blocks/:blockId/attachment`, re-checks the current user's current page access, forces download disposition, applies `nosniff`, a sandboxing Content Security Policy, and a same-origin resource policy. Backup restore applies the same blocked-filename and active-MIME policy as direct upload. The configured attachment root is rejected when it equals or is nested under the public web root, including case-insensitive Windows paths, and startup removes stale staging files without touching committed attachments. Deleting an attachment block, a parent block containing attachments, or a permanently deleted page subtree also removes the associated files.

`ATTACHMENT_STORAGE_MAX_MB` defaults to 2048 MB and caps committed attachment bytes per account. Accounts are also limited to 5,000 committed attachment files so zero-byte or tiny uploads cannot exhaust filesystem inodes without crossing the byte quota. Upload accounting runs while the owner row is locked, so concurrent writers cannot each reserve the same remaining capacity. Backup restore validates the replacement attachment generation against both limits before staging files. Set the byte limit below the usable capacity of the dedicated attachment volume and reserve additional space for temporary uploads, backup staging, and interrupted-restore recovery generations.

Do not point `ATTACHMENT_UPLOAD_DIR` at `public/`, `docs/`, `.git/`, or the project root.

## Backup and restore safety

Each exported attachment entry is recorded with its byte size, CRC-32, and SHA-256 digest. Restore validates the ZIP directory, manifest relationships, entry paths, counts, and attachment digests before replacing workspace data.

Files are staged first, and the database replacement runs inside a transaction so a malformed or incomplete backup does not partially overwrite the account.

The browser also acquires renewable page/workspace transition leases across same-origin tabs. Each open editor is given a chance to flush. Export is blocked while an owned active or archived page has an unsaved direct draft or unacknowledged local Yjs recovery snapshot, restore is blocked by the Yjs recovery condition, permanent subtree deletion applies the same Yjs guard to every page in the server-validated deletion scope, and archiving refuses to disconnect collaborators while the page has a local recovery record. This closes the gap between server-side version checks and edits that exist only in browser storage.

Restore is intentionally destructive for workspace content: current pages, collections, blocks, tag links, page sharing grants, and the attachment directory are replaced by the backup state. Login credentials and MFA/passkey security material are not exported and remain unchanged.

Current-format backups bind page sharing grants to both the collaborator's stable account ID and username. Restore locks accounts by ID and requires the exact pair to match before deleting any page; an unrelated destination account with the same username is not accepted. Username-only sharing records from the earlier backup format are accepted only when each record matches a currently locked page-to-account grant; username lookup alone is never used, and mixed legacy/current records fail closed. Archived ordinary pages may retain grants: archive blocks live collaboration, while backup and restore preserve the access list so unarchiving does not silently lose collaborators. Legacy backups without a `pageShares` field preserve the account's current grants for matching imported ordinary page IDs, including archived pages, preventing the page deletion cascade from silently erasing them. The historical Yjs update log is still excluded; the backup stores the latest server-materialized document state and restore creates a fresh collaboration generation.

`DATA_TRANSFER_MAX_SIZE_MB` defaults to 1024 MB and is enforced before multipart intake when `Content-Length` is present, by Multer while streaming the file, against the ZIP's total stored-entry size, during export attachment staging, and against the completed export plan. `DATA_TRANSFER_MAX_MANIFEST_SIZE_MB` defaults to 16 MB; an oversized manifest is rejected before its bytes are allocated for parsing. Export still streams the final archive instead of buffering the complete backup in memory.

Backup manifests are bounded to 20,000 pages, 50,000 blocks, 20,000 tags, 100,000 page-tag relations, 20,000 sharing grants, and 5,000 attachments. Import accepts at most 5,001 ZIP entries, including the manifest, and at most a 4 MiB central directory. BrainVault accepts only its UTF-8, store-mode ZIP format, so compressed-entry expansion is not available as an import path.

Authenticated imports are limited before multipart bytes are accepted. Defaults allow three attempts per principal per hour, one active import per principal, and two concurrent imports per application process. These controls are process-local; multi-instance deployments must enforce an equivalent shared policy at the proxy or with a distributed limiter. Only ZIP files produced by BrainVault's data export are accepted.

## Metadata, URL, and restore validation

The unauthenticated health response contains only `{ "ok": true }`. Internal repository documentation is not served unless `SERVE_INTERNAL_DOCS=true` is explicitly configured, and enabled documentation routes still require an authenticated session. Invalid JSON is reported as a client error, database constraint responses use a stable application error code, and backup conflicts do not disclose identifiers owned by another account. Page cover URLs accept only `http:` and `https:` schemes, including during backup restore. Restored profile avatars are revalidated for MIME type, image signature, and size before account data is replaced.

## Security defaults

The server includes:

- A security-patched Node.js runtime enforced during dependency installation
- Helmet security headers, exact versioned external resources, and explicit CORS/WebSocket origin allowlists in every environment
- Global, bookmark-preview, data export/import, login, MFA-login, MFA-enrollment, and registration rate limiting
- Persisted exponential password-failure backoff and current-password verification for password/MFA changes
- Encrypted TOTP secrets with current-step replay protection by default
- One-time, expiring MFA and WebAuthn challenges
- WebAuthn user verification, strict JWT audience separation, and credential-change session revocation
- Zod input validation and validated profile-image data
- Private attachment storage with filename, media-type, signature, authenticated-download, and upload-size controls
- `private, no-store` caching at the authenticated middleware boundary, with credential-varying private revalidation only for page-cover bytes
- Sanitized Markdown/HTML output with bounded, deadline-protected syntax highlighting

These defaults are a starting point, not a substitute for HTTPS, secure secret storage, database and attachment backups, dependency updates, and production monitoring.
