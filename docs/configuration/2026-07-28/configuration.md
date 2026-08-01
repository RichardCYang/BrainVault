# Configuration

BrainVault reads runtime settings from environment variables. For local development, copy [`.env.example`](../../../.env.example) to `.env` with `npm run env:init`, or use `npm run db:configure` to create/update `.env` interactively. To generate fresh 32-byte values without changing files, run `npm run secrets:generate`; pass `-- --write` to fill empty or generated placeholders in an existing `.env`.

Never commit a real `.env` file.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment |
| `HOST` | `127.0.0.1` | Network address to bind; set `0.0.0.0` or `::` only when external access is intentional |
| `PORT` | `4000` | HTTP port |
| `DATABASE_URL` | Required; `env:init` generates the password | MariaDB connection used by the app; a non-empty, non-default password is required |
| `MARIADB_ADMIN_URL` | Not set | Optional admin connection for database and exact-host user creation |
| `DB_USER_HOSTS` | `localhost,127.0.0.1,::1` | Comma-separated exact MariaDB account hosts; `%` and `_` wildcards are rejected |
| `AUTO_BOOTSTRAP_DATABASE` | `true` | Run database bootstrap before listening |
| `DATABASE_CONNECTION_LIMIT` | `10` | Maximum database pool size |
| `JWT_SECRET` | Random ephemeral value outside production | Secret used to sign access tokens; `env:init` writes a persistent random value and production requires an explicit non-placeholder value |
| `JWT_EXPIRES_IN` | `7d` | Access-token lifetime |
| `MFA_ENCRYPTION_KEY` | Random ephemeral value outside production | Independent key material used to encrypt TOTP secrets; `env:init` writes a persistent random value |
| `WEBAUTHN_RP_NAME` | `BrainVault` | Name shown during passkey registration |
| `WEBAUTHN_RP_ID` | `localhost` | WebAuthn relying-party domain without scheme or port |
| `WEBAUTHN_ORIGIN` | `http://localhost:4000` | Comma-separated exact browser origins accepted for WebAuthn responses |
| `CORS_ORIGIN` | Local development origins | Comma-separated browser origins allowed to call the API |
| `PUBLIC_ORIGIN` | First `WEBAUTHN_ORIGIN` | Canonical browser-facing origin used for safe HTTPS redirects |
| `HTTPS_MODE` | `off` | Set `proxy` when a trusted reverse proxy terminates public TLS |
| `HTTPS_REDIRECT` | Enabled in proxy mode | Redirect unrecognized HTTP requests to `PUBLIC_ORIGIN` with status 308; when false, return HTTP 426 |
| `HTTPS_HEALTHCHECK_BYPASS` | `true` | Allow `/health` on the private backend HTTP listener |
| `REGISTRATION_ENABLED` | Enabled outside production; disabled in production | Allow unauthenticated account creation |
| `SERVE_INTERNAL_DOCS` | `false` | Serve the repository `docs/` directory at authenticated `/docs` routes |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds |
| `RATE_LIMIT_MAX` | `120` | Maximum requests per global window |
| `AUTH_LOGIN_IP_WINDOW_MS` | `900000` | Login IP throttling window |
| `AUTH_LOGIN_IP_MAX` | `20` | Failed login requests allowed per IP window |
| `AUTH_LOGIN_ACCOUNT_WINDOW_MS` | `3600000` | Account-keyed login throttling window |
| `AUTH_LOGIN_ACCOUNT_MAX` | `30` | Failed or MFA-pending login requests allowed per normalized account window |
| `AUTH_MFA_IP_WINDOW_MS` | `900000` | MFA login verification IP window |
| `AUTH_MFA_IP_MAX` | `15` | Failed MFA login verifications allowed per IP window |
| `AUTH_MFA_ACCOUNT_WINDOW_MS` | `3600000` | MFA login account window and failure-carry interval |
| `AUTH_MFA_ACCOUNT_MAX` | `20` | Failed MFA login verifications allowed per account window |
| `AUTH_MFA_SETUP_WINDOW_MS` | `900000` | TOTP enrollment verification account window |
| `AUTH_MFA_SETUP_MAX` | `10` | Failed TOTP enrollment verifications allowed per account window |
| `AUTH_REGISTER_WINDOW_MS` | `3600000` | Registration throttling window |
| `AUTH_REGISTER_MAX` | `5` | Registration requests allowed per IP window |
| `TRUST_PROXY_ADDRESSES` | Empty | Comma-separated proxy IPs, CIDRs, or `loopback`/`linklocal`/`uniquelocal`; recommended over hop trust |
| `TRUST_PROXY_HOPS` | `0` | Exact trusted reverse-proxy hop count; cannot be combined with `TRUST_PROXY_ADDRESSES` |
| `BOOKMARK_FETCH_TIMEOUT_MS` | `8000` | Maximum duration of one OpenGraph page fetch |
| `BOOKMARK_FETCH_MAX_BYTES` | `524288` | Maximum document-head bytes inspected for one bookmark preview |
| `ATTACHMENT_UPLOAD_DIR` | `uploads` | Private on-disk directory for attachment bytes |
| `MAX_ATTACHMENT_SIZE_MB` | `25` | Maximum size of one uploaded attachment in megabytes |
| `DATA_TRANSFER_MAX_SIZE_MB` | `4096` | Maximum size of one uploaded complete-data backup ZIP in megabytes |

## Development browser launch

`npm run dev` always opens the local application in a private/incognito browser window after server readiness. This behavior is not controlled by an environment variable, and the launcher never falls back to a normal browser profile. Chrome, Edge, Firefox, and Brave are supported for automatic launch. The former `BRAINVAULT_DEV_BROWSER_PRIVATE` variable is ignored and can be removed from existing local `.env` files.

## Database behavior

With `AUTO_BOOTSTRAP_DATABASE=true`, application startup attempts to prepare the target database, reconcile the baseline schema, and apply migrations before listening.

Use `MARIADB_ADMIN_URL` when the application account does not yet exist or cannot create the database/user itself. Bootstrap creates or updates the application account on each exact `DB_USER_HOSTS` entry, grants only `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `INDEX`, `DROP`, and `REFERENCES` on the target schema, and removes the same username at the wildcard host `%`. To move schema management outside the application, set:

```env
AUTO_BOOTSTRAP_DATABASE=false
```

See [Getting started](../../getting-started/2026-07-27/getting-started.md#database-bootstrap) for the bootstrap sequence and database commands.

## Production values

At minimum, production deployments should provide unique values for:

```env
NODE_ENV=production
HOST="127.0.0.1"
DATABASE_URL="mariadb://brainvault:use-a-unique-database-password@127.0.0.1:3306/brainvault"
DB_USER_HOSTS="localhost,127.0.0.1"
JWT_SECRET="replace-with-a-unique-secret-of-at-least-32-characters"
MFA_ENCRYPTION_KEY="replace-with-a-different-secret-of-at-least-32-characters"
WEBAUTHN_RP_ID="notes.example.com"
WEBAUTHN_ORIGIN="https://notes.example.com"
CORS_ORIGIN="https://notes.example.com"
PUBLIC_ORIGIN="https://notes.example.com"
HTTPS_MODE=proxy
HTTPS_REDIRECT=true
HTTPS_HEALTHCHECK_BYPASS=true
REGISTRATION_ENABLED=false
SERVE_INTERNAL_DOCS=false
TRUST_PROXY_ADDRESSES="loopback"
TRUST_PROXY_HOPS=0
```

For a proxy in another container or host, replace `loopback` with the exact proxy IP or narrowest practical CIDR. `HTTPS_MODE=proxy` refuses to start without one of the two trust settings, and `PUBLIC_ORIGIN` must be HTTPS and present in both `WEBAUTHN_ORIGIN` and `CORS_ORIGIN`. Keep the backend port private. See the repository [reverse-proxy deployment guide](../../../deploy/README.md) for Caddy, Synology DSM, NGINX, and Nginx Proxy Manager examples.

`JWT_SECRET` and `MFA_ENCRYPTION_KEY` must be different. Known example values and legacy development defaults are rejected even outside production. Do not change `MFA_ENCRYPTION_KEY` casually after users enroll TOTP. Existing encrypted authenticator secrets depend on that key and become unusable when it changes.

## Browser lock and secure-context requirement

Safety-critical cross-tab transitions—permanent deletion, archive, sharing changes, direct block deletion, and complete workspace restore—require the browser Web Locks API. BrainVault intentionally does not substitute a `localStorage` lease for atomic exclusion. If `navigator.locks` is unavailable, the operation is blocked before any destructive request is sent.

Serve production over HTTPS and use a browser that supports Web Locks. Local development on `localhost` can continue to use the documented HTTP URL. Normal editing remains available when the API is absent, but safety-critical persistence-mode transitions fail closed.

## WebSocket proxying and Yjs delivery

Real-time collaboration uses the same `PORT`, `CORS_ORIGIN`, and JWT signing secret as the HTTP API. No separate collaboration process or port is required. A production reverse proxy must support HTTP/1.1 WebSocket upgrades for `/api/collaboration/` and forward the browser origin and original host/protocol headers. The application uses the trusted `X-Forwarded-Proto` value to recognize the external HTTPS request; it never uses forwarded host headers to authorize browser origins or construct redirects.

The included collaboration hub is process-local and is intended to run as one active application process. Patched writers compare every room tip with the locked durable tip and invalidate a stale room before it can insert or compact, which prevents silent loss during accidental overlap but does not provide cross-process broadcasts. Horizontal scaling requires a shared pub/sub and distributed update coordinator so every instance observes the same room history and presence events. Drain all pre-fix collaboration writers before starting this version.

The browser imports the exact `yjs@13.6.31` ESM build and exact `katex@0.17.0` assets from versioned jsDelivr paths. The Content Security Policy allows only those resource paths and exact WebSocket origins derived from `CORS_ORIGIN`; it does not allow the complete CDN host or arbitrary `ws:`/`wss:` destinations. Deployments that vendor scripts locally must update the public asset references and `src/app.ts` as one reviewed change.

See [Collaboration](../../collaboration/2026-07-29/collaboration.md#authentication-and-network-requirements) and the [reverse-proxy deployment guide](../../../deploy/README.md) for complete examples.
