# Configuration

BrainVault reads runtime settings from environment variables. For local development, copy [`.env.example`](../../../.env.example) to `.env` with `npm run env:init`, or use `npm run db:configure` to create/update `.env` interactively.

Never commit a real `.env` file.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment |
| `PORT` | `4000` | HTTP port |
| `DATABASE_URL` | Local BrainVault database | MariaDB connection used by the app |
| `MARIADB_ADMIN_URL` | Not set | Optional admin connection for database and user creation |
| `AUTO_BOOTSTRAP_DATABASE` | `true` | Run database bootstrap before listening |
| `BRAINVAULT_DEV_BROWSER_PRIVATE` | `false` | Open a supported private/incognito browser window during `npm run dev` |
| `DATABASE_CONNECTION_LIMIT` | `10` | Maximum database pool size |
| `JWT_SECRET` | Development-only value | Secret used to sign access tokens; minimum 32 characters |
| `JWT_EXPIRES_IN` | `7d` | Access-token lifetime |
| `MFA_ENCRYPTION_KEY` | Development-only value | Key material used to encrypt TOTP secrets; minimum 32 characters |
| `WEBAUTHN_RP_NAME` | `BrainVault` | Name shown during passkey registration |
| `WEBAUTHN_RP_ID` | `localhost` | WebAuthn relying-party domain without scheme or port |
| `WEBAUTHN_ORIGIN` | `http://localhost:4000` | Comma-separated exact browser origins accepted for WebAuthn responses |
| `CORS_ORIGIN` | Local development origins | Comma-separated browser origins allowed to call the API |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds |
| `RATE_LIMIT_MAX` | `120` | Maximum requests per window |
| `BOOKMARK_FETCH_TIMEOUT_MS` | `8000` | Maximum duration of one OpenGraph page fetch |
| `BOOKMARK_FETCH_MAX_BYTES` | `524288` | Maximum document-head bytes inspected for one bookmark preview |
| `ATTACHMENT_UPLOAD_DIR` | `uploads` | Private on-disk directory for attachment bytes |
| `MAX_ATTACHMENT_SIZE_MB` | `25` | Maximum size of one uploaded attachment in megabytes |
| `DATA_TRANSFER_MAX_SIZE_MB` | `4096` | Maximum size of one uploaded complete-data backup ZIP in megabytes |

## Database behavior

With `AUTO_BOOTSTRAP_DATABASE=true`, application startup attempts to prepare the target database, reconcile the baseline schema, and apply migrations before listening.

Use `MARIADB_ADMIN_URL` when the application account does not yet exist or cannot create the database/user itself. To move schema management outside the application, set:

```env
AUTO_BOOTSTRAP_DATABASE=false
```

See [Getting started](../../getting-started/2026-07-27/getting-started.md#database-bootstrap) for the bootstrap sequence and database commands.

## Production values

At minimum, production deployments should provide unique values for:

```env
NODE_ENV=production
JWT_SECRET="replace-with-a-unique-secret-of-at-least-32-characters"
MFA_ENCRYPTION_KEY="replace-with-a-different-secret-of-at-least-32-characters"
WEBAUTHN_RP_ID="notes.example.com"
WEBAUTHN_ORIGIN="https://notes.example.com"
CORS_ORIGIN="https://notes.example.com"
```

Do not change `MFA_ENCRYPTION_KEY` casually after users enroll TOTP. Existing encrypted authenticator secrets depend on that key and become unusable when it changes.

## Browser lock and secure-context requirement

Safety-critical cross-tab transitions—permanent deletion, archive, sharing changes, direct block deletion, and complete workspace restore—require the browser Web Locks API. BrainVault intentionally does not substitute a `localStorage` lease for atomic exclusion. If `navigator.locks` is unavailable, the operation is blocked before any destructive request is sent.

Serve production over HTTPS and use a browser that supports Web Locks. Local development on `localhost` can continue to use the documented HTTP URL. Normal editing remains available when the API is absent, but safety-critical persistence-mode transitions fail closed.

## WebSocket proxying and Yjs delivery

Real-time collaboration uses the same `PORT`, `CORS_ORIGIN`, and JWT signing secret as the HTTP API. No separate collaboration process or port is required. A production reverse proxy must support HTTP/1.1 WebSocket upgrades for `/api/collaboration/` and forward the browser origin and original host/protocol headers.

The included collaboration hub is process-local and is intended to run as one active application process. Patched writers compare every room tip with the locked durable tip and invalidate a stale room before it can insert or compact, which prevents silent loss during accidental overlap but does not provide cross-process broadcasts. Horizontal scaling requires a shared pub/sub and distributed update coordinator so every instance observes the same room history and presence events. Drain all pre-fix collaboration writers before starting this version.

The browser imports the exact `yjs@13.6.31` ESM build from jsDelivr. The built-in Content Security Policy allows that script source and `ws:`/`wss:` connections. Deployments that vendor scripts locally must update both `public/collaboration.js` and the CSP in `src/app.ts` as one reviewed change.

See [Collaboration](../../collaboration/2026-07-29/collaboration.md#authentication-and-network-requirements) for an Nginx example.
