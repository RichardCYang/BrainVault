# Security

## Two-step verification

Open **Settings → Security** to configure either verification method:

- **Authenticator app (TOTP):** BrainVault displays a QR code and manual setup key, then enables the method only after a valid six-digit code is confirmed. The stored TOTP secret is encrypted with AES-256-GCM, and a code cannot be replayed within the same time step.
- **Passkeys (WebAuthn/FIDO2):** Add, name, rename, and remove multiple platform passkeys or external hardware security keys. Each credential is stored separately so a primary device and recovery keys can coexist.

After the password is accepted, accounts with at least one configured method receive a short-lived, one-time MFA session instead of a JWT. Completing an available TOTP or passkey challenge issues the normal access token. The built-in browser client receives the token in an `HttpOnly`, `SameSite=Strict` session cookie and does not persist the JWT in Web Storage. Bearer tokens remain available for non-browser API clients.

Local WebAuthn development works at `http://localhost:4000`. Production deployments should use HTTPS and set `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` to the exact relying-party domain and browser origin.

Changing `MFA_ENCRYPTION_KEY` after users enroll TOTP invalidates their encrypted authenticator secrets. Store and rotate it through a managed secret process.

## Secret generation and startup guards

`npm run env:init` generates independent cryptographically random values for `JWT_SECRET` and `MFA_ENCRYPTION_KEY`; it never copies usable public secrets from the example file. Production requires both variables explicitly. Known placeholders, legacy development values, and reuse of one value for both purposes are rejected at startup. When no secret is configured outside production, BrainVault uses per-process ephemeral values rather than a shared repository constant.

The HTTP server binds to `127.0.0.1` by default. External binding requires an explicit `HOST` setting.

## Authentication abuse controls

Login is protected by both IP-keyed and normalized-account-keyed failed-attempt limits. Registration has a separate IP limit, defaults to disabled in production, and returns a generic duplicate-account error. The in-memory limiter is suitable for one process; multi-instance deployments should use a shared rate-limit store.

## Credential-change session revocation

API access tokens and page-scoped collaboration tickets use separate JWT audiences, a fixed HS256 algorithm, and the `brainvault` issuer. Tokens also carry the account's current authentication generation. Changing the password increments that generation, deletes unfinished MFA and WebAuthn login state, immediately closes local collaboration sockets, and returns a replacement access token for the browser that completed the change. Older API tokens, collaboration tickets, and periodically rechecked sockets fail closed.

The `024_auth_session_revocation.sql` migration adds the non-secret `users.auth_version` generation counter. Deploying this version invalidates legacy JWTs that do not contain the strict issuer, audience, and generation claims, so users should expect to sign in again once after the upgrade.

## Browser origin policy

Production browser origins must be listed explicitly in `CORS_ORIGIN`. API CORS and collaboration WebSocket origin checks never derive authorization from `X-Forwarded-Host` or `X-Forwarded-Proto`, because those headers can be supplied by a direct client unless every network path is constrained by a trusted proxy. Loopback HTTP(S) origins remain available automatically only outside production.

## Bookmark preview safety

Browser cross-origin rules prevent the editor from reading arbitrary page HTML directly, so OpenGraph retrieval uses the authenticated `/api/bookmarks/preview` server endpoint.

The fetcher:

- Accepts only public HTTP(S) destinations
- Revalidates every redirect
- Rejects local, private, and reserved IP ranges
- Pins validated DNS results
- Allows Node.js to fall back between IPv4 and IPv6 connection attempts
- Reads only the document head up to the configured byte limit
- Supports common legacy page character sets

Use `BOOKMARK_FETCH_TIMEOUT_MS` and `BOOKMARK_FETCH_MAX_BYTES` to control fetch limits.

## Shared-page collaboration safety

Only a page owner can create or remove editor grants. Session issuance, WebSocket upgrade, periodic live-connection checks, relational materialization, attachment access, and normal page reads each re-check the authenticated user’s owner/editor access. Removing a grant closes that user’s sockets immediately; archiving or deleting the page closes the room.

Collaboration tickets are short-lived, page-scoped JWTs sent in the WebSocket subprotocol rather than the URL. The server validates browser origin, RFC 6455 framing and masking, frame/message size, update rate, current page state, and the ticket’s user/page scope. Accepted binary updates are committed to MariaDB before acknowledgement and broadcast. Every write also compares the process-local room tip with the locked durable update tip; a room that missed another process's update is invalidated before insertion or compaction.

A client cannot create an attachment merely by inserting Yjs metadata. New attachment blocks must come from the authenticated upload endpoint, and relational materialization preserves or validates canonical file metadata. Snapshot validation also rejects duplicate/global block IDs, missing parents, cycles, excessive nesting, stale update markers, replaced document epochs, and title/block limits. Session tickets, WebSocket rooms, database writes, and browser recovery records carry the same epoch so an offline pre-restore Yjs document cannot be replayed into a newly initialized page with the same page ID. Session issuance requires the generation-aware client protocol marker, which prevents already-open pre-fix tabs from reconnecting with legacy recovery behavior after a deployment.

For an attachment that already exists in the collaboration document, its parent and order come from the acknowledged Yjs state rather than the potentially lagging relational session snapshot. The SQL snapshot remains authoritative for immutable file identity and metadata, and is used for position only when the attachment is genuinely missing from Yjs. Collaboration protocol version 2 and WebSocket subprotocol `brainvault-yjs-v2` reject cached pre-fix writers during deployment.

See [Collaboration](../../collaboration/2026-07-29/collaboration.md) for the complete access and persistence model.

## Attachment safety

Uploaded bytes are stored under `ATTACHMENT_UPLOAD_DIR`, which defaults to `uploads/` at the project root. This directory is ignored by Git and is never mounted as a public static directory.

Every download goes through `/api/blocks/:blockId/attachment`, re-checks the current user's current page access, and sends the file with download disposition. Deleting an attachment block, a parent block containing attachments, or a permanently deleted page subtree also removes the associated files.

Do not point `ATTACHMENT_UPLOAD_DIR` at `public/`, `docs/`, `.git/`, or the project root.

## Backup and restore safety

Each exported attachment entry is recorded with its byte size, CRC-32, and SHA-256 digest. Restore validates the ZIP directory, manifest relationships, entry paths, counts, and attachment digests before replacing workspace data.

Files are staged first, and the database replacement runs inside a transaction so a malformed or incomplete backup does not partially overwrite the account.

The browser also acquires renewable page/workspace transition leases across same-origin tabs. Each open editor is given a chance to flush. Export is blocked while an owned active or archived page has an unsaved direct draft or unacknowledged local Yjs recovery snapshot, restore is blocked by the Yjs recovery condition, permanent subtree deletion applies the same Yjs guard to every page in the server-validated deletion scope, and archiving refuses to disconnect collaborators while the page has a local recovery record. This closes the gap between server-side version checks and edits that exist only in browser storage.

Restore is intentionally destructive for workspace content: current pages, collections, blocks, tag links, page sharing grants, and the attachment directory are replaced by the backup state. Login credentials and MFA/passkey security material are not exported and remain unchanged.

Current-format backups bind page sharing grants to both the collaborator's stable account ID and username. Restore locks accounts by ID and requires the exact pair to match before deleting any page; an unrelated destination account with the same username is not accepted. Username-only sharing records from the earlier backup format are accepted only when each record matches a currently locked page-to-account grant; username lookup alone is never used, and mixed legacy/current records fail closed. Archived ordinary pages may retain grants: archive blocks live collaboration, while backup and restore preserve the access list so unarchiving does not silently lose collaborators. Legacy backups without a `pageShares` field preserve the account's current grants for matching imported ordinary page IDs, including archived pages, preventing the page deletion cascade from silently erasing them. The historical Yjs update log is still excluded; the backup stores the latest server-materialized document state and restore creates a fresh collaboration generation.

`DATA_TRANSFER_MAX_SIZE_MB` limits one uploaded backup ZIP and defaults to 4096 MB. Export streams the archive instead of buffering the complete backup in memory. Only ZIP files produced by BrainVault's data export are accepted.

## Metadata, URL, and restore validation

The unauthenticated health response contains only `{ "ok": true }`. Internal repository documentation is not served unless `SERVE_INTERNAL_DOCS=true` is explicitly configured. Page cover URLs accept only `http:` and `https:` schemes, including during backup restore. Restored profile avatars are revalidated for MIME type, image signature, and size before account data is replaced.

## Security defaults

The server includes:

- Helmet security headers and an explicit production CORS/WebSocket origin allowlist
- Request rate limiting
- Password hashing and current-password verification for password/MFA changes
- Encrypted TOTP secrets with replay protection
- One-time, expiring MFA and WebAuthn challenges
- WebAuthn user verification, strict JWT audience separation, and credential-change session revocation
- Zod input validation and validated profile-image data
- Private attachment storage with authenticated downloads and upload-size limits
- Sanitized Markdown/HTML output

These defaults are a starting point, not a substitute for HTTPS, secure secret storage, database and attachment backups, dependency updates, and production monitoring.
