# Security

## Two-step verification

Open **Settings → Security** to configure either verification method:

- **Authenticator app (TOTP):** BrainVault displays a QR code and manual setup key, then enables the method only after a valid six-digit code is confirmed. The stored TOTP secret is encrypted with AES-256-GCM, and a code cannot be replayed within the same time step.
- **Passkeys (WebAuthn/FIDO2):** Add, name, rename, and remove multiple platform passkeys or external hardware security keys. Each credential is stored separately so a primary device and recovery keys can coexist.

After the password is accepted, accounts with at least one configured method receive a short-lived, one-time MFA session instead of a JWT. Completing an available TOTP or passkey challenge issues the normal access token.

Local WebAuthn development works at `http://localhost:4000`. Production deployments should use HTTPS and set `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` to the exact relying-party domain and browser origin.

Changing `MFA_ENCRYPTION_KEY` after users enroll TOTP invalidates their encrypted authenticator secrets. Store and rotate it through a managed secret process.

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

## Attachment safety

Uploaded bytes are stored under `ATTACHMENT_UPLOAD_DIR`, which defaults to `uploads/` at the project root. This directory is ignored by Git and is never mounted as a public static directory.

Every download goes through `/api/blocks/:blockId/attachment`, re-checks the current user's ownership, and sends the file with download disposition. Deleting an attachment block, a parent block containing attachments, or a permanently deleted page subtree also removes the associated files.

Do not point `ATTACHMENT_UPLOAD_DIR` at `public/`, `docs/`, `.git/`, or the project root.

## Backup and restore safety

Each exported attachment entry is recorded with its byte size, CRC-32, and SHA-256 digest. Restore validates the ZIP directory, manifest relationships, entry paths, counts, and attachment digests before replacing workspace data.

Files are staged first, and the database replacement runs inside a transaction so a malformed or incomplete backup does not partially overwrite the account.

Restore is intentionally destructive for workspace content: current pages, collections, blocks, tag links, and the attachment directory are replaced by the backup state. Login credentials and MFA/passkey security material are not exported and remain unchanged.

`DATA_TRANSFER_MAX_SIZE_MB` limits one uploaded backup ZIP and defaults to 4096 MB. Export streams the archive instead of buffering the complete backup in memory. Only ZIP files produced by BrainVault's data export are accepted.

## Security defaults

The server includes:

- Helmet security headers and a configurable CORS allowlist
- Request rate limiting
- Password hashing and current-password verification for password/MFA changes
- Encrypted TOTP secrets with replay protection
- One-time, expiring MFA and WebAuthn challenges
- WebAuthn user verification and JWT verification
- Zod input validation and validated profile-image data
- Private attachment storage with authenticated downloads and upload-size limits
- Sanitized Markdown/HTML output

These defaults are a starting point, not a substitute for HTTPS, secure secret storage, database and attachment backups, dependency updates, and production monitoring.
