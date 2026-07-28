# Development

## Available scripts

| Command | Purpose |
| --- | --- |
| `npm run lockfile:check` | Reject machine-specific registry URLs in `package-lock.json` |
| `npm run lockfile:repair` | Normalize registry tarball URLs to the configured public registry |
| `npm run env:init` | Create `.env` from `.env.example` when needed |
| `npm run db:configure` | Prompt for database credentials and update/create `.env` |
| `npm run db:init` | Prepare the database and verify connectivity |
| `npm run db:migrate` | Reconcile the schema and apply migrations |
| `npm run db:seed` | Add the demo account and starter content |
| `npm run setup` | Run environment, database, migration, and seed tasks |
| `npm run dev` | Start the server and open the default browser after database readiness |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm run reproduce:materialization-loss` | Reproduce the old browser-payload materialization loss and verify the server-authoritative fix from preserved Git history |
| `npm run reproduce:cross-instance-loss` | Reproduce stale cross-process room compaction loss and verify the durable-tip fence |
| `npm run verify:collaboration` | Check exact Yjs pins, collaboration wiring, durable-room freshness, hierarchy invariants, RFC 6455 behavior, and all executable JS/TS syntax without MariaDB |
| `npm run verify:data-loss` | Execute dependency-free persistence, recovery, destructive-transition, and collaboration integrity guards |
| `npm start` | Run the compiled server |
| `npm test` | Validate the lockfile and run the test suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run preview:capture` | Capture `docs/preview.png` from the local browser UI |

## Dependency lockfile reliability

`package-lock.json` is intentionally committed and must not be deleted during a normal install. The project-level `.npmrc` keeps registry downloads portable, replaces stale registry hosts with the configured registry, and limits fetch retries so an unreachable registry produces a bounded failure instead of appearing to loop indefinitely.

Before committing dependency changes, validate the lockfile:

```bash
npm run lockfile:check
```

When the check reports URLs from an internal mirror or another machine-specific registry, repair and review the lockfile:

```bash
npm run lockfile:repair
git diff -- package-lock.json
```

For reproducible clean installs in CI, prefer:

```bash
npm ci
```

Teams that intentionally use a private registry can temporarily add its hostname through `BRAINVAULT_ALLOWED_NPM_REGISTRY_HOSTS`. Do not commit credentials or machine-only registry URLs to the lockfile.

## Project structure

```text
BrainVault/
├── docs/                 # Guides, preview asset, and OpenAPI specification
├── migrations/           # MariaDB schema migrations
├── public/               # Browser UI
├── uploads/              # Runtime attachment bytes (Git-ignored; created automatically)
├── scripts/              # Environment, database, migration, seed, and preview tasks
├── src/
│   ├── config/           # Environment parsing
│   ├── lib/              # Database, auth, Markdown, WebSocket, and collaboration helpers
│   ├── middleware/       # Validation, authentication, CORS, and errors
│   ├── routes/           # REST endpoints
│   ├── types/            # Domain and Express type definitions
│   └── utils/            # Block-tree and schema utilities
├── tests/                # Vitest and Supertest coverage
├── .env.example
├── .npmrc                # Portable registry and bounded retry settings
├── package.json
└── tsconfig.json
```

## Translations

Translations live in `public/i18n.js`. Static HTML uses `data-i18n*` attributes, while dynamic interface messages use the `t()` helper from the same module.

The supported language identifiers are `en`, `ja`, `ko`, `fr`, `de`, `es`, and `pt`. Browser-language detection and user preference behavior are described in [Features](features.md#languages).

## Preview capture

The root README image is captured from the actual BrainVault browser UI (`public/index.html` and `public/app.js`) in the default English read mode. It uses the same English sample workspace data as `npm run db:seed`; it is not a separately drawn mockup.

Regenerate it locally with:

```bash
npm run preview:capture
```

Chromium or Chrome is required. The command updates [`docs/preview.png`](preview.png).

## Collaboration implementation

The browser adapter is `public/collaboration.js`. Access/session/materialization routes live in `src/routes/collaboration.routes.ts`; the authenticated room server is `src/lib/collaboration-server.ts`; and the dependency-free RFC 6455 transport is `src/lib/websocket.ts`. Database objects are introduced by `migrations/020_page_sharing_yjs_collaboration.sql`.

Keep the pinned Yjs browser version, CSP allowlist, protocol tests, and collaboration documentation synchronized when changing the transport. Run `npm run verify:collaboration`, `npm run build`, and `npm test` before deployment.
