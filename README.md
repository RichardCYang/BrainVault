# BrainVault

BrainVault is a self-hosted, block-based note app built with Node.js, Express, TypeScript, and MariaDB. It pairs a focused browser interface with a REST API, so the same project works as a personal writing space and as a backend for other clients.

Writing happens directly on the page. There is no separate preview pane: every row is an editable block that can be formatted, moved, nested, or changed into another block type without leaving the document.

## Highlights

- Page-first workspace with a compact document tree and automatic title saving
- Slash commands for headings, tasks, quotes, callouts, tables, code, dividers, and images
- Drag-and-drop block reordering with support for nested content
- Inline formatting for bold, italic, strikethrough, code, links, and text color
- Editable table blocks with row, column, header, and keyboard navigation controls
- Search across page titles and block content
- Tags, page nesting, archiving, and permanent deletion
- Username-and-password authentication backed by JWT
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
| Authentication | JSON Web Tokens and bcrypt |
| Validation | Zod |
| Markdown | markdown-it and sanitize-html |
| Testing | Vitest and Supertest |
| Frontend | Vanilla HTML, CSS, and JavaScript |

## Requirements

- Node.js 22.13 or newer
- npm 10 or newer
- A running MariaDB server

Docker is not required. MariaDB may run locally or on a remote host, as long as the credentials in `DATABASE_URL` can reach it.

## Getting started

Install the dependencies and create a local environment file:

```bash
npm install
npm run env:init
```

Open `.env` and confirm the database connection:

```env
DATABASE_URL="mariadb://brainvault:brainvault_password@127.0.0.1:3306/brainvault"
```

Start the development server:

```bash
npm run dev
```

With `AUTO_BOOTSTRAP_DATABASE=true`, startup creates the database when permitted, reconciles the base schema, and applies any pending migrations. The app will be available at:

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
/h1  /h2  /h3  /todo  /quote  /callout  /table  /code  /divider  /image
```

Table cells support arrow-key movement. `Enter` advances down the current column, while `Tab` from the final cell adds another row.

## Available scripts

| Command | Purpose |
| --- | --- |
| `npm run env:init` | Create `.env` from `.env.example` when needed |
| `npm run db:init` | Prepare the database and verify connectivity |
| `npm run db:migrate` | Reconcile the schema and apply migrations |
| `npm run db:seed` | Add the demo account and starter content |
| `npm run setup` | Run environment, database, migration, and seed tasks |
| `npm run dev` | Start the server in watch mode |
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
| `CORS_ORIGIN` | Local development origins | Comma-separated browser origins allowed to call the API |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds |
| `RATE_LIMIT_MAX` | `120` | Maximum requests per window |

Never commit a real `.env` file. The repository already ignores it; keep shareable defaults in `.env.example` instead.

## API

Most API routes require a bearer token returned by the register or login endpoint.

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create an account |
| `POST` | `/api/auth/login` | Sign in and receive a JWT |
| `GET` | `/api/auth/me` | Read the current user |
| `GET` | `/api/pages` | List pages |
| `POST` | `/api/pages` | Create a page |
| `GET` | `/api/pages/:pageId` | Read a page and its block tree |
| `PATCH` | `/api/pages/:pageId` | Update page metadata |
| `DELETE` | `/api/pages/:pageId` | Archive or permanently delete a page |
| `POST` | `/api/pages/:pageId/blocks` | Add a block |
| `PATCH` | `/api/blocks/:blockId` | Update a block |
| `DELETE` | `/api/blocks/:blockId` | Delete a block and its descendants |
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

Before using production mode, set a unique `JWT_SECRET` with at least 32 characters. The server refuses to start in production when the bundled development secret is still in use.

## Project structure

```text
BrainVault/
├── docs/                 # OpenAPI specification
├── migrations/           # MariaDB schema migrations
├── public/               # Browser UI
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
├── package.json
└── tsconfig.json
```

## Security defaults

The server includes Helmet headers, a configurable CORS allowlist, request rate limiting, password hashing, JWT verification, Zod input validation, and sanitized HTML output. Those defaults are a starting point rather than a substitute for HTTPS, secure secret storage, database backups, and normal production monitoring.

## Interface language

The bundled browser interface currently uses Korean labels and messages. The server API, OpenAPI document, and codebase can be used independently of the UI.
