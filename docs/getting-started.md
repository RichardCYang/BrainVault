# Getting started

## Requirements

- Node.js 22.13 or newer
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

To create an unchanged local environment file from the example instead, run:

```bash
npm run env:init
```

Never commit a real `.env` file. The repository ignores it; keep shareable defaults in [`.env.example`](../.env.example).

## Start the development server

```bash
npm run dev
```

With `AUTO_BOOTSTRAP_DATABASE=true`, startup creates the database when permitted, reconciles the baseline schema, and applies pending migrations, including migration `020_page_sharing_yjs_collaboration.sql` for page grants and persistent Yjs updates. After MariaDB is ready and the HTTP server is listening, the development command opens the app once in the system default browser's normal profile so crash-recovery drafts remain available across browser restarts.

The app is available at:

```text
http://localhost:4000
```

Set `BRAINVAULT_DEV_BROWSER_PRIVATE=true` only when ephemeral private/incognito storage is intentional. Private-mode launch supports Chrome, Edge, Firefox, and Brave. When the requested private window cannot be opened, BrainVault reports the issue instead of silently falling back to a normal window.

## Optional demo data

After the database is ready, seed a sample account and starter page:

```bash
npm run db:seed
```

Development credentials:

```text
Username: demo
Password: brainvault123
```

These credentials are for local development only.

## Database bootstrap

In the simplest setup, the account in `DATABASE_URL` needs permission to create the target database and run DDL statements.

When that account does not exist yet, add an administrator connection:

```env
MARIADB_ADMIN_URL="mariadb://root:your-root-password@127.0.0.1:3306"
```

The bootstrap process can then:

1. Create the database when it is missing.
2. Create the application user when necessary.
3. Grant access to the target database.
4. Reconcile the baseline schema.
5. Apply migrations that have not run yet.

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

For a complete first-time setup, including demo data, run:

```bash
npm run setup
```

## Production build

Compile the TypeScript source, then run the generated server:

```bash
npm run build
npm start
```

Automatic browser launch belongs exclusively to `npm run dev`; production execution never invokes it.

Before using production mode:

- Set unique `JWT_SECRET` and `MFA_ENCRYPTION_KEY` values with at least 32 characters.
- Set `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` to the production relying-party domain and exact browser origin.
- Use HTTPS, managed secret storage, database backups, and normal production monitoring.

For real-time collaboration behind a reverse proxy, enable WebSocket upgrades for `/api/collaboration/` and preserve the original origin, host, and protocol headers. See [Collaboration](collaboration.md#authentication-and-network-requirements).

The server refuses to start in production when either bundled development secret is still in use. See [Security](security.md) and [Configuration](configuration.md) for details.
