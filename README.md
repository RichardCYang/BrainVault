# BrainVault

BrainVault is a self-hosted, block-based note app built with Node.js, Express, TypeScript, and MariaDB. It pairs a focused browser interface with a REST API, so the same project works as a personal writing space and as a backend for other clients.

Writing happens directly on the page. There is no separate preview pane: every row is an editable block that can be formatted, moved, nested, or changed into another block type without leaving the document.

## Highlights

- Page-first workspace with a compact document tree and automatic title saving
- Unicode Emoji 17 picker for every page and collection, with Korean/English search, categories, skin-tone variants, and recent selections
- Slash commands for headings, tasks, quotes, callouts, tables, databases, boards, AI conversations, code, dividers, images, and file attachments
- Drag-and-drop block reordering with support for nested content
- Inline formatting for bold, italic, strikethrough, code, links, and text color
- Block text alignment for left, center, right, and justified paragraphs
- Editable table blocks with row, column, header, and keyboard navigation controls
- Database blocks with typed properties, saved table/board/list views, per-view property visibility, filters, sorting, and board grouping
- Kanban board blocks with editable groups, card emojis, pastel card themes, descriptions, tags, drag-and-drop, and mobile move controls
- Web bookmark blocks with compact favicon/title lists or OpenGraph gallery cards containing thumbnails, titles, descriptions, and site information
- Search across page titles and block content
- Current-page PDF export using the browser print engine, with preserved colors and backgrounds, wide-block scaling, and print-safe pagination
- Browser-language detection plus an account-level language preference for English, Japanese, Korean, French, German, Spanish, and Portuguese
- Page nesting, archiving, and permanent deletion from page and collection three-dot menus
- Username-and-password authentication backed by JWT, with profile photos, display names, and in-app password changes
- Optional two-step verification with TOTP authenticator apps or multiple WebAuthn/FIDO2 passkeys per account
- Authenticated attachment upload/download with configurable file-size limits and private disk storage
- Sanitized Markdown rendering through `markdown-it` and `sanitize-html`
- Automatic MariaDB database and schema bootstrap during server startup
- OpenAPI 3.1 specification included in the repository

## Stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js 22.13+ |
| Server | Express 5 |
| Language | TypeScript |
| Database | MariaDB |
| Authentication | JSON Web Tokens, bcrypt, RFC 6238 TOTP, and WebAuthn/FIDO2 passkeys |
| Validation | Zod |
| File upload | Multer |
| Markdown | markdown-it and sanitize-html |
| Testing | Vitest and Supertest |
| Frontend | Vanilla HTML, CSS, and JavaScript |

## Requirements

- Node.js 22.13 or newer
- npm 10 or newer
- A running MariaDB server

Docker is not required. MariaDB may run locally or on a remote host, as long as the credentials in `DATABASE_URL` can reach it.

## Getting started

Configure the database credentials interactively, then install the dependencies:

```bash
npm run db:configure
npm install
```

The command uses only Node.js built-ins, so it can run before `npm install`. It asks for the database username and password, hides the password in an interactive terminal, and updates `DATABASE_URL` in `.env`. It preserves the current protocol, host, port, and database name. When `.env` does not exist, it creates one from `.env.example` before applying the credentials.

You can still create an unchanged local environment file from the example with:

```bash
npm run env:init
```

### Dependency lockfile reliability

`package-lock.json` is intentionally committed and must not be deleted as part of a normal install. The project-level `.npmrc` keeps registry downloads portable, replaces stale registry hosts with the configured registry, and limits fetch retries so an unreachable registry produces a bounded failure instead of appearing to loop indefinitely.

Before committing dependency changes, validate the lockfile:

```bash
npm run lockfile:check
```

If the check reports URLs from an internal mirror or another machine-specific registry, repair and review the lockfile:

```bash
npm run lockfile:repair
git diff -- package-lock.json
```

For reproducible clean installs in CI, prefer:

```bash
npm ci
```

Teams that intentionally use a private registry can add its hostname temporarily through `BRAINVAULT_ALLOWED_NPM_REGISTRY_HOSTS`; do not commit credentials or machine-only registry URLs to the lockfile.

Start the development server:

```bash
npm run dev
```

With `AUTO_BOOTSTRAP_DATABASE=true`, startup creates the database when permitted, reconciles the base schema, and applies any pending migrations. After MariaDB is ready and the HTTP server is listening, the development command opens the app in the system default browser's private/incognito mode. The browser is opened only once for the current watch session, even when source changes restart the server.

Automatic private-mode launch supports Chrome, Edge, Firefox, and Brave. If the default browser cannot be opened privately (for example, Safari has no supported private-window command-line switch), BrainVault reports the issue and does not fall back to a normal browser window. The app remains available at:

```text
http://localhost:4000
```

### Optional demo data

After the database is ready, seed a sample account and starter page:

```bash
npm run db:seed
```

Development credentials:

```text
Username: demo
Password: brainvault123
```

These credentials are intended for local use only.

## Database setup

BrainVault can prepare its own database and tables. In the simplest setup, the account in `DATABASE_URL` needs permission to create the target database and run DDL statements.

When that account does not exist yet, add an administrator connection:

```env
MARIADB_ADMIN_URL="mariadb://root:your-root-password@127.0.0.1:3306"
```

The bootstrap process will then:

1. Create the database when it is missing.
2. Create the application user when necessary.
3. Grant access to the target database.
4. Reconcile the baseline schema.
5. Apply migrations that have not run yet.

To manage schema changes outside the application, disable startup bootstrap:

```env
AUTO_BOOTSTRAP_DATABASE=false
```

The database tasks are also available as separate commands:

```bash
npm run db:init
npm run db:migrate
npm run db:seed
```

For a complete first-time setup, run:

```bash
npm run setup
```

## Two-step verification

Open **Settings → Security** to configure either verification method:

- **Authenticator app (TOTP):** BrainVault displays a QR code and manual setup key, then enables the method only after a valid six-digit code is confirmed. The stored TOTP secret is encrypted with AES-256-GCM, and a code cannot be replayed within the same time step.
- **Passkeys (WebAuthn/FIDO2):** Add, name, rename, and remove multiple platform passkeys or external hardware security keys. Each credential is stored separately so a primary device and multiple recovery keys can coexist.

After the password is accepted, accounts with at least one configured method receive a short-lived, one-time MFA session instead of a JWT. Completing either an available TOTP or passkey challenge issues the normal access token.

Local WebAuthn development works at `http://localhost:4000`. Production deployments should use HTTPS and set `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` to the exact relying-party domain and browser origin. Changing `MFA_ENCRYPTION_KEY` after users enroll TOTP invalidates their encrypted authenticator secrets, so store and rotate it through a managed secret process.

## Editor basics

| Action | Result |
| --- | --- |
| `Enter` | Insert a block below the current one |
| `Shift + Enter` | Add a line break inside the same block |
| `Backspace` on an empty block | Remove it and move focus to the previous block |
| `/` | Open the block type menu |
| `Ctrl/Cmd + B` | Apply bold formatting to selected text |
| `Ctrl/Cmd + I` | Apply italic formatting to selected text |
| Drag the six-dot handle | Reorder a block within its current hierarchy |

Useful slash commands include:

```text
/h1  /h2  /h3  /todo  /quote  /callout  /table  /database  /board  /bookmark  /ai  /code  /divider  /image  /file
```

Table cells support arrow-key movement. `Enter` advances down the current column, while `Tab` from the final cell adds another row.

Type `/database` to create a database block. Each database has one required title property plus optional text, number, select, multi-select, checkbox, date, and URL properties. Add table, board, or list views over the same rows; each view keeps its own name, layout, visible properties, filters, sort order, and board grouping. The editor uses a borderless database toolbar with view tabs, popover-based Properties/Filter/Sort controls, in-view search, a split New button, transparent column headers, and colored select pills. Property and row changes are stored in the block's `metadata.database` object, while a searchable text summary is kept in `markdown`.

Kanban boards support direct title/group/card editing. Open the icon button beside a card title to choose an emoji, paste a custom emoji, or apply a default, pink, yellow, blue, light-green, purple, or peach pastel card theme. Drag the six-dot card handle to reorder cards or move them between groups; the arrow buttons provide the same cross-group movement on touch devices and for keyboard users.

### AI conversation blocks

Type `/ai` to store a question and an AI answer as a clean two-sided chat transcript. The question appears as a right-aligned bubble and the answer appears as a left-aligned bubble with its AI identity and response metadata.

The built-in icon picker includes ChatGPT, Gemini, Claude, DeepSeek, and Grok. The provider icon, a free-form model name, the local answer date/time, the question, and the answer are stored under `metadata.aiChat`. BrainVault also writes a bounded text summary to `markdown`, so page and block search can match the provider, model, question, or answer. Read mode hides the configuration controls while keeping the conversation presentation intact.

### Bookmark blocks

Type `/bookmark` to create a web bookmark collection inside the page. Paste an HTTP or HTTPS URL and BrainVault fetches the page metadata on the server. The block can switch between:

- **List:** a compact row for each link containing only its favicon and title.
- **Gallery:** responsive cards containing the OpenGraph thumbnail, title, description, favicon, and site name.

Each bookmark can be refreshed or removed. Stored metadata lives under `metadata.bookmark`, while titles, descriptions, and URLs are summarized into `markdown` so normal block search can find them.

Because browser cross-origin rules prevent the editor from reading arbitrary page HTML directly, OpenGraph retrieval uses the authenticated `/api/bookmarks/preview` server endpoint. The fetcher accepts only public HTTP(S) destinations, revalidates every redirect, rejects local/private/reserved IP ranges, pins all validated DNS results, and lets Node.js fall back between IPv4 and IPv6 connection attempts. It reads only the document head up to the configured byte limit and supports common legacy page character sets.

When a public site blocks automated preview requests, times out, returns a non-HTML response, or is temporarily unreachable, BrainVault still adds a basic bookmark containing the original URL, hostname, and default favicon path. The editor reports that fallback instead of discarding the link; use the refresh action later to retry OpenGraph metadata retrieval.

### Attachment blocks

Type `/file` in a block, choose **Attachment**, and select a file. If the current block contains only the slash command, it is replaced in place; otherwise the attachment is inserted directly below it. The attachment card shows the original filename, media type, size, and an authenticated download button.

Uploaded bytes are stored under `ATTACHMENT_UPLOAD_DIR`, which defaults to `uploads/` at the project root. This directory is ignored by Git and is never mounted as a public static directory. Every download goes through `/api/blocks/:blockId/attachment`, re-checks the current user's ownership, and sends the file with download disposition. Deleting an attachment block, a parent block containing attachments, or a permanently deleted page subtree also removes the associated files.

The default maximum file size is 25 MB. Adjust `MAX_ATTACHMENT_SIZE_MB` when needed. Do not point `ATTACHMENT_UPLOAD_DIR` at `public/`, `docs/`, `.git/`, or the project root.

## Languages

The browser interface supports:

- English (`en`)
- Japanese (`ja`)
- Korean (`ko`)
- French (`fr`)
- German (`de`)
- Spanish (`es`)
- Portuguese (`pt`)

On the first visit, BrainVault checks `navigator.languages` and selects the first supported browser language, falling back to English when no match is available. After sign-in, open the user card at the top of the sidebar and choose **Preferences** to change the language. The selection is saved both to the account and to `localStorage` under `brainvault.language`.

Translations live in `public/i18n.js`. Static HTML uses `data-i18n*` attributes, while dynamic interface messages use the `t()` helper from the same module.

## Available scripts

| Command | Purpose |
| --- | --- |
| `npm run lockfile:check` | Reject machine-specific registry URLs in `package-lock.json` |
| `npm run lockfile:repair` | Normalize registry tarball URLs to the public npm registry |
| `npm run env:init` | Create `.env` from `.env.example` when needed |
| `npm run db:configure` | Prompt for DB credentials and update or create `.env` |
| `npm run db:init` | Prepare the database and verify connectivity |
| `npm run db:migrate` | Reconcile the schema and apply migrations |
| `npm run db:seed` | Add the demo account and starter content |
| `npm run setup` | Run environment, database, migration, and seed tasks |
| `npm run dev` | Start the server in watch mode and open the private default browser after DB readiness |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm start` | Run the compiled server |
| `npm test` | Execute the test suite once |
| `npm run test:watch` | Run tests in watch mode |

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment |
| `PORT` | `4000` | HTTP port |
| `DATABASE_URL` | Local BrainVault database | MariaDB connection used by the app |
| `MARIADB_ADMIN_URL` | Not set | Optional admin connection for database and user creation |
| `AUTO_BOOTSTRAP_DATABASE` | `true` | Run database bootstrap before listening |
| `DATABASE_CONNECTION_LIMIT` | `10` | Maximum pool size |
| `JWT_SECRET` | Development-only value | Secret used to sign access tokens; minimum 32 characters |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |
| `MFA_ENCRYPTION_KEY` | Development-only value | Key material used to encrypt TOTP secrets; minimum 32 characters |
| `WEBAUTHN_RP_NAME` | `BrainVault` | Name shown by browsers during passkey registration |
| `WEBAUTHN_RP_ID` | `localhost` | WebAuthn relying-party domain, without scheme or port |
| `WEBAUTHN_ORIGIN` | `http://localhost:4000` | Comma-separated exact browser origins accepted for WebAuthn responses |
| `CORS_ORIGIN` | Local development origins | Comma-separated browser origins allowed to call the API |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds |
| `RATE_LIMIT_MAX` | `120` | Maximum requests per window |
| `BOOKMARK_FETCH_TIMEOUT_MS` | `8000` | Maximum duration of one OpenGraph page fetch |
| `BOOKMARK_FETCH_MAX_BYTES` | `524288` | Maximum document-head bytes inspected for one bookmark preview |
| `ATTACHMENT_UPLOAD_DIR` | `uploads` | Private on-disk directory for uploaded attachment bytes |
| `MAX_ATTACHMENT_SIZE_MB` | `25` | Maximum size of one uploaded attachment in megabytes |

Never commit a real `.env` file. The repository already ignores it; keep shareable defaults in `.env.example` instead.

## API

Most API routes require a bearer token returned by the register or login endpoint.

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create an account |
| `POST` | `/api/auth/login` | Sign in; returns either a JWT or a temporary MFA session |
| `GET` | `/api/auth/mfa/status` | Read configured TOTP and passkey methods |
| `POST` | `/api/auth/mfa/totp/setup` | Begin current-password-protected TOTP enrollment |
| `POST` | `/api/auth/mfa/totp/verify` | Confirm and enable a pending TOTP enrollment |
| `DELETE` | `/api/auth/mfa/totp` | Disable TOTP after current-password verification |
| `POST` | `/api/auth/mfa/passkeys/options` | Begin current-password-protected passkey registration |
| `POST` | `/api/auth/mfa/passkeys` | Verify and store a passkey credential |
| `PATCH` | `/api/auth/mfa/passkeys/:id` | Rename a registered passkey |
| `DELETE` | `/api/auth/mfa/passkeys/:id` | Remove a passkey after current-password verification |
| `POST` | `/api/auth/mfa/login/totp` | Complete a pending login with a TOTP code |
| `POST` | `/api/auth/mfa/login/passkey/options` | Create a passkey authentication challenge |
| `POST` | `/api/auth/mfa/login/passkey/verify` | Verify a passkey and complete login |
| `GET` | `/api/auth/me` | Read the current user |
| `PATCH` | `/api/auth/profile` | Update display name, profile image, or preferred language |
| `POST` | `/api/auth/password` | Change the password after verifying the current password |
| `GET` | `/api/pages` | List pages |
| `POST` | `/api/pages` | Create a page |
| `GET` | `/api/pages/:pageId` | Read a page and its block tree |
| `PATCH` | `/api/pages/:pageId` | Update page metadata |
| `DELETE` | `/api/pages/:pageId` | Archive or permanently delete a page |
| `POST` | `/api/pages/:pageId/blocks` | Add a non-attachment block |
| `POST` | `/api/bookmarks/preview` | Fetch sanitized OpenGraph metadata for a public web page URL |
| `POST` | `/api/pages/:pageId/attachments` | Upload a file and create an attachment block |
| `PATCH` | `/api/blocks/:blockId` | Update a block |
| `DELETE` | `/api/blocks/:blockId` | Delete a block and its descendants, including stored attachment files |
| `GET` | `/api/blocks/:blockId/attachment` | Download an attachment after ownership verification |
| `POST` | `/api/pages/:pageId/blocks/reorder` | Move or reorder blocks |
| `GET` | `/api/pages/:pageId/render` | Render sanitized page HTML |
| `GET` | `/api/search?q=...` | Search titles and block Markdown |

The full OpenAPI document is served at:

```text
http://localhost:4000/docs/openapi.yaml
```

A simple health check is available without authentication:

```bash
curl http://localhost:4000/health
```

## Production build

Compile the TypeScript source, then run the generated server:

```bash
npm run build
npm start
```

The automatic browser launch belongs exclusively to `npm run dev`; `npm start` and production execution never invoke it. Before using production mode, set unique `JWT_SECRET` and `MFA_ENCRYPTION_KEY` values with at least 32 characters, and configure the production WebAuthn RP ID and origin. The server refuses to start in production when either bundled development secret is still in use.

## Project structure

```text
BrainVault/
├── docs/                 # OpenAPI specification
├── migrations/           # MariaDB schema migrations
├── public/               # Browser UI
├── uploads/              # Runtime attachment bytes (Git-ignored; created automatically)
├── scripts/              # Environment, database, migration, and seed tasks
├── src/
│   ├── config/           # Environment parsing
│   ├── lib/              # Database, auth, Markdown, and shared helpers
│   ├── middleware/       # Validation, authentication, CORS, and errors
│   ├── routes/           # REST endpoints
│   ├── types/            # Domain and Express type definitions
│   └── utils/            # Block-tree and schema utilities
├── tests/                # Vitest and Supertest coverage
├── .env.example
├── .npmrc               # Portable registry and bounded retry settings
├── package.json
└── tsconfig.json
```

## Security defaults

The server includes Helmet headers, a configurable CORS allowlist, request rate limiting, password hashing, current-password verification for password and MFA changes, encrypted TOTP secrets with replay protection, one-time expiring MFA/WebAuthn challenges, WebAuthn user verification, JWT verification, Zod input validation, validated profile-image data, private attachment storage with authenticated downloads, upload-size limits, and sanitized HTML output. Those defaults are a starting point rather than a substitute for HTTPS, secure secret storage, database backups, and normal production monitoring.

## PDF export

Open any page and select **Export PDF** in the page toolbar. BrainVault prepares only the current page, removes editor-only controls, keeps backgrounds and colors, expands horizontally scrollable tables and boards, and opens the browser print dialog. Choose **Save as PDF** to create the file.

The print stylesheet uses A4 landscape pages so the default 900 px document layout stays unchanged whenever possible. Exceptionally wide tables, Kanban boards, and database views are scaled uniformly to prevent horizontal clipping.

## Interface language

The bundled browser interface currently uses Korean labels and messages. The server API, OpenAPI document, and codebase can be used independently of the UI.
