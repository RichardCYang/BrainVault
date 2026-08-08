# Getting started

## Requirements

- Node.js 22.23.2 or newer within the 22.x line, Node.js 24.18.1 or newer within the 24.x line, or Node.js 26.5.1 or newer
- npm 10.9 or newer
- A running MariaDB server

Docker is not required. MariaDB may run locally or on a remote host as long as the credentials in `DATABASE_URL` can reach it.

## First-time setup

Configure the database credentials interactively, then install the dependencies:

```bash
npm run db:configure
npm install
```

`db:configure` uses only Node.js built-ins, so it can run before `npm install`. It asks for the database username and password, hides the password in an interactive terminal, and updates `DATABASE_URL` in `.env`. It preserves the current protocol, host, port, and database name. When `.env` does not exist, it creates one from `.env.example` before applying the credentials.

To create a local environment file with random database, JWT, and MFA secrets instead, run:

```bash
npm run env:init
```

Never commit a real `.env` file. The repository ignores it; keep shareable defaults in [`.env.example`](../../../.env.example).

## Start the development server

```bash
npm run dev
```

With `AUTO_BOOTSTRAP_DATABASE=true`, startup creates the database when permitted, reconciles the baseline schema, and applies pending migrations, including migration `020_page_sharing_yjs_collaboration.sql` for page grants and persistent Yjs updates. After MariaDB is ready and the HTTP server is listening, the development command opens the app once in a private/incognito browser window.

The app is available at:

```text
http://localhost:4000
```

Private-mode launch supports Chrome, Edge, Firefox, and Brave. BrainVault first asks the system default browser for a private window, then retries installed supported browsers with their browser-specific private-mode command-line switch. If no private window can be launched, it reports the issue and deliberately does not open a normal browser window. Safari cannot be launched directly in private mode from the command line, so a supported installed browser is required for automatic launch on macOS.

## Optional demo data

Demo seeding is disabled by default and never uses a repository-defined password. To create the sample workspace, provide an explicit password of 12-128 characters that is no more than 72 UTF-8 bytes:

```bash
BRAINVAULT_SEED_DEMO=true \
BRAINVAULT_DEMO_USERNAME=demo \
BRAINVAULT_DEMO_PASSWORD="use-a-unique-local-password" \
npm run db:seed
```

Do not reuse a real account password. The seed command prints the username but never prints or stores the plaintext password outside the database hash.

## Database bootstrap

In the simplest setup, the account in `DATABASE_URL` needs permission to create the target database and run DDL statements.

When that account does not exist yet, add an administrator connection:

```env
MARIADB_ADMIN_URL="mariadb://root:your-root-password@127.0.0.1:3306"
```

The bootstrap process can then:

1. Create the database when it is missing.
2. Create or update the application user on each exact host in `DB_USER_HOSTS`.
3. Remove the legacy wildcard-host account for the same username.
4. Grant only the application and migration privileges required on the target database.
5. Reconcile the baseline schema.
6. Apply migrations that have not run yet.

To manage schema changes outside the application, disable startup bootstrap:

```env
AUTO_BOOTSTRAP_DATABASE=false
```

Database tasks are also available separately:

```bash
npm run db:init
npm run db:migrate
npm run db:seed
```

For a complete first-time schema setup, run:

```bash
npm run setup
```

The setup command creates `.env` with separate cryptographically random database, JWT, and MFA secrets, initializes the database, and applies migrations. When the application database account does not already exist, configure `MARIADB_ADMIN_URL` first so bootstrap can create the exact-host account. It does not create a shared demo account.

## Production build

Compile the TypeScript source, then run the generated server:

```bash
npm run build
npm start
```

Automatic browser launch belongs exclusively to `npm run dev`; production execution never invokes it.

Before using production mode:

- Set `HOST` to the intended bind address. The default `127.0.0.1` is loopback-only.
- Set unique `JWT_SECRET` and `MFA_ENCRYPTION_KEY` values with at least 32 characters; production refuses missing, placeholder, legacy, or identical values.
- Set `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` to the production relying-party domain and exact browser origin.
- Keep `REGISTRATION_ENABLED` unset or `false` unless public sign-up is intentional.
- Keep `SERVE_INTERNAL_DOCS=false` unless authenticated project documentation must be exposed deliberately.
- Set `DB_USER_HOSTS` to the exact application client hosts and rerun `npm run db:init` to remove any legacy wildcard account.
- Set `PUBLIC_ORIGIN` to the canonical HTTPS origin. Use `HTTPS_MODE=posh-acme` with `POSH_ACME_CERT_PATH` for direct Posh-ACME TLS, or `HTTPS_MODE=proxy` when a trusted reverse proxy terminates TLS.
- In proxy mode, configure `TRUST_PROXY_ADDRESSES` with the exact proxy IP or narrowest practical CIDR. Numeric `TRUST_PROXY_HOPS` trust is disabled and must remain `0`.
- In proxy mode, keep the backend HTTP port private; allow only the proxy or local health checker to reach it. In Posh-ACME mode, expose only the intended HTTPS listener.
- Use HTTPS, managed secret storage, database backups, and normal production monitoring.

Direct Posh-ACME mode carries collaboration over the same native HTTPS listener. Behind a reverse proxy, enable WebSocket upgrades for `/api/collaboration/` and preserve the original origin, host, and protocol headers. See [Collaboration](../../collaboration/2026-07-29/collaboration.md#authentication-and-network-requirements) and the repository [HTTPS deployment guide](../../../deploy/README.md).

The server refuses to start when `DATABASE_URL` contains a missing or known default password, and production also refuses either cryptographic secret when missing or known to be a public placeholder. Development without configured cryptographic secrets uses per-process ephemeral values, while `npm run env:init` writes persistent random values. See [Security](../../security/2026-07-30/security.md) and [Configuration](../../configuration/2026-07-28/configuration.md) for details.
