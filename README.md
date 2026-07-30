# BrainVault

BrainVault is a self-hosted, block-based note app built with Node.js, Express, TypeScript, and MariaDB. It combines a focused browser workspace with a REST API, so it can be used as both a personal writing environment and a backend for other clients.

Every row on a page is an editable block that can be formatted, moved, nested, or converted without switching to a separate preview pane.

## Preview

![BrainVault main workspace preview with Kanban and database blocks](docs/assets/2026-07-17/preview.png)

The preview is captured from the real browser UI. See [Development guide](docs/development/2026-07-28/development.md#preview-capture) to regenerate it.

## Key features

- Block editor with slash commands, nested content, drag-and-drop ordering, tables, databases, and Kanban boards
- Rich text, Markdown, code, callouts, bookmarks, file attachments, AI conversation blocks, and KaTeX formulas
- Crash-resilient browser drafts, automatic title saving, and search across page titles and block content
- Owner-managed page sharing with Yjs-based simultaneous title/block editing, live presence, reconnect recovery, and MariaDB persistence
- Page collections, nesting, archiving, permanent deletion, PDF export, and complete ZIP backup/restore including sharing grants
- JWT authentication, profile settings, TOTP authenticator support, and multiple WebAuthn/FIDO2 passkeys
- Seven interface languages: English, Japanese, Korean, French, German, Spanish, and Portuguese
- Private attachment storage, sanitized Markdown rendering, rate limiting, and validated bookmark previews
- Automatic MariaDB bootstrap and migrations, plus an included OpenAPI 3.1 specification

## Stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js 22.13+, Express 5, TypeScript |
| Database | MariaDB |
| Frontend | Vanilla HTML, CSS, and JavaScript, with Yjs 13.6.31 for shared documents |
| Auth | JWT, bcrypt, TOTP, and WebAuthn/FIDO2 |
| Validation and rendering | Zod, markdown-it, sanitize-html, and KaTeX |
| Testing | Vitest and Supertest |

## Quick start

Requirements: Node.js 22.13 or newer, npm 10.9 or newer, and a reachable MariaDB server.

```bash
npm run db:configure
npm install
npm run dev
```

Open `http://localhost:4000` after the server starts.

For database permissions, demo data, alternative environment setup, and production instructions, see the [Getting started guide](docs/getting-started/2026-07-27/getting-started.md).

## Documentation

| Guide | Contents |
| --- | --- |
| [Documentation index](docs/README.md) | Entry point for all project documentation |
| [Getting started](docs/getting-started/2026-07-27/getting-started.md) | Requirements, setup, database bootstrap, demo data, and production |
| [Features](docs/features/2026-07-30/features.md) | Editor behavior, sharing, block types, backup/restore, PDF export, and languages |
| [Collaboration](docs/collaboration/2026-07-29/collaboration.md) | Sharing permissions, Yjs/WebSocket flow, persistence, proxy setup, and verification |
| [Collaboration verification](docs/data-loss/2026-07-29/collaboration-verification.md) | Delivery checks, integrity-proof scope, and reproducible deployment validation |
| [Data-loss and integrity reports](docs/README.md#data-loss-and-integrity-reports) | Dated audits, reproductions, corrections, and verification evidence |
| [Configuration](docs/configuration/2026-07-28/configuration.md) | Environment variables and runtime configuration |
| [Security](docs/security/2026-07-30/security.md) | MFA, production secrets, attachment safety, and security defaults |
| [API](docs/api/2026-07-30/api.md) | Route overview, authentication, health check, and OpenAPI access |
| [Development](docs/development/2026-07-28/development.md) | Scripts, lockfile policy, project structure, translations, and preview capture |
| [OpenAPI specification](docs/api/2026-07-30/openapi.yaml) | Full OpenAPI 3.1 document |

## Common commands

```bash
npm run dev       # Start the development server
npm test          # Run the test suite
npm run build     # Compile TypeScript
npm run reproduce:cross-instance-loss # Reproduce the stale-room compaction loss and fixed behavior
npm run reproduce:attachment-position-loss # Reproduce stale-SQL attachment position loss and the fixed merge
npm run verify:collaboration # Check collaboration wiring, protocol behavior, and source syntax
npm run verify:data-loss # Check persistence and recovery integrity guards
npm start         # Run the compiled server
```

Before a production deployment, replace the bundled development secrets, configure the WebAuthn relying-party values, and serve the app over HTTPS in a browser that supports Web Locks so safety-critical cross-tab transitions can run. See [Security](docs/security/2026-07-30/security.md) and [Configuration](docs/configuration/2026-07-28/configuration.md).
