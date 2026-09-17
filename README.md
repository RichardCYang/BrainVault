# BrainVault

BrainVault is a self-hosted, block-based note app built with Node.js, Express, TypeScript, and MariaDB. It combines a focused browser workspace with a REST API, so it can be used as both a personal writing environment and a backend for other clients.

Every row on a page is an editable block that can be formatted, moved, nested, or converted without switching to a separate preview pane.

## Preview

![BrainVault main workspace preview with structured project blocks](docs/assets/2026-08-09/preview.png)

The preview is captured from the real browser UI. See [Development guide](docs/development/2026-07-28/development.md#preview-capture) to regenerate it.

## Key features

- Block editor with slash commands, nested content, drag-and-drop ordering, tables, databases, Kanban boards, and Gantt timelines
- Rich text, Markdown, syntax-highlighted code blocks, callouts, bookmarks, privacy-enhanced video embeds, file attachments, AI conversation blocks, and KaTeX formulas
- Crash-resilient browser drafts, automatic title saving, and search across page titles and block content
- Owner- and administrator-managed sharing: ordinary pages use direct `EDIT` grants, while custom collections use inherited `READ`, `WRITE`, or `ADMIN` grants; shared documents use Yjs live synchronization, presence, reconnect recovery, and MariaDB persistence
- Page collections, nesting, built-in or custom cover images with adjustable focal positions, archiving, permanent deletion, PDF export, and complete ZIP backup/restore including page and collection sharing grants, page version history, owned-page navigation state, every account attachment-upload file, and uploaded custom-icon assets
- Custom page/collection icon uploads stored as physical files under `upload/icons/`; MariaDB stores only the generated file path, and missing files fall back to the default page icon
- JWT authentication with an HttpOnly browser session cookie, profile settings, TOTP authenticator support, multiple WebAuthn/FIDO2 passkeys, and passwordless passkey-first login from the sign-in screen
- Seven interface languages: English, Japanese, Korean, French, German, Spanish, and Portuguese
- Private attachment storage, sanitized Markdown rendering, rate limiting, and validated bookmark previews
- Automatic MariaDB bootstrap and migrations, plus an included OpenAPI 3.1 specification
- Production HTTPS via a Posh-ACME certificate directory or a trusted Caddy, Synology DSM, NGINX, or Nginx Proxy Manager reverse proxy

## Collection sharing

BrainVault can share an entire **custom collection** with another existing BrainVault account. A collection grant covers the collection and every document page currently inside it, including nested descendant pages. Pages created in or moved into the collection inherit the collection grant; pages moved out stop inheriting it.

**Where to find the UI:** click a custom collection's **name** in the left sidebar to open the collection landing view. Owners and users with `ADMIN` collection permission see **Share collection** next to **Add page**. The button is intentionally hidden for the virtual **Default Collection**, while an individual document page is open, and for `READ`/`WRITE` collection collaborators. Direct sharing of a single ordinary page remains available from that page's **Share** button.

| Collection permission | Effective access |
| --- | --- |
| `READ` | View the collection and its document hierarchy. Shared documents can receive live Yjs updates, but this user cannot write them. |
| `WRITE` | Everything in `READ`, plus editing shared document titles/blocks and other writable document content. It does not grant sharing or page-administration controls. |
| `ADMIN` | Everything in `WRITE`, plus collection sharing and page/collection administration allowed by the server. An administrator cannot move pages outside the shared collection's scope. |

A collection grant is authoritative for a user inside that collection and takes precedence over a direct page `EDIT` grant. For example, a collection-level `READ` grant keeps member pages read-only for that user even if an older direct `EDIT` grant is still stored for one of those pages. If the collection grant is later removed, a still-valid direct page grant can become effective again.

Collection sharing is persisted in `collection_shares`, while `page_collection_memberships` materializes each page's collection scope. Current version 5 backups strictly require collection grants in addition to direct page grants and preserve collection-share update timestamps. See [Collection sharing](docs/collaboration/2026-09-02/collection-sharing.md) for UI behavior, permission semantics, API routes, inheritance rules, backup behavior, and troubleshooting.

## Syntax-highlighted code blocks

Code blocks include a language selector, a live highlighted preview, persisted language metadata, read-only/PDF rendering, and highlighted fenced code inside Markdown blocks. Highlight.js assets are served locally from `public/vendor/highlight`, so code highlighting does not require a third-party CDN. To bound synchronous regular-expression work on untrusted notes, blocks longer than 2,000 code units or server highlights that exceed 25 ms fall back to complete HTML-escaped plain text; browser hydration also has an aggregate work budget.

Supported selectors include C, C++, C#, Java, Python, Dart, Rust, Lua, Ruby, Perl, Bash, PowerShell, JSON, SQL, XML, YAML, Markdown, HTML, JavaScript, CSS, PHP, VB.NET, BASIC, Assembly, Delphi, Lisp, TypeScript, CoffeeScript, COBOL, Fortran (`POTRAN` is accepted as an alias), MATLAB, Kotlin, Objective-C, Swift, and Haskell.

## Stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js 22.23.2+/24.18.1+/26.5.1+, Express 5, TypeScript |
| Database | MariaDB |
| Frontend | Vanilla HTML, CSS, and JavaScript, with Yjs 13.6.31 for shared documents |
| Auth | JWT, bcrypt, TOTP, and WebAuthn/FIDO2 |
| Validation and rendering | Zod, markdown-it, sanitize-html, and KaTeX |
| Testing | Vitest and Supertest |

## Quick start

Requirements: Node.js 22.23.2 or newer within the 22.x line, Node.js 24.18.1 or newer within the 24.x line, or Node.js 26.5.1 or newer; npm 10.9 or newer; and a reachable MariaDB server.

```bash
npm run db:configure
npm install
npm run setup
npm run dev
```

`npm run dev` opens `http://localhost:4000` automatically in a private/incognito window after the server is ready. It never falls back to a normal browser profile.

Custom icon uploads are written to `upload/icons/<user-id>/`. Keep the project `upload/` directory on persistent storage in production; it is runtime data and is ignored by Git. Migration `041_custom_icon_files.sql` creates the MariaDB path-reference library used by the custom-icon picker.

For database permissions, opt-in demo data, alternative environment setup, and production instructions, see the [Getting started guide](docs/getting-started/2026-07-27/getting-started.md).

## Documentation

| Guide | Contents |
| --- | --- |
| [Documentation index](docs/README.md) | Entry point for maintained project documentation |
| [Getting started](docs/getting-started/2026-07-27/getting-started.md) | Requirements, secure setup, database bootstrap, opt-in demo data, and production |
| [Features](docs/features/2026-07-30/features.md) | Editor behavior, sharing, block types, backup/restore, PDF export, and languages |
| [Collaboration](docs/collaboration/2026-07-29/collaboration.md) | Sharing permissions, Yjs/WebSocket flow, persistence, proxy setup, and verification |
| [Collection sharing](docs/collaboration/2026-09-02/collection-sharing.md) | Custom-collection UI entry point, READ/WRITE/ADMIN permissions, inheritance, API routes, and troubleshooting |
| [Configuration](docs/configuration/2026-07-28/configuration.md) | Environment variables and runtime configuration |
| [HTTPS deployment](deploy/README.md) | Direct Posh-ACME TLS plus Caddy, Synology DSM, NGINX, and Nginx Proxy Manager setup |
| [Security](docs/security/2026-07-30/security.md) | MFA, production secrets, attachments, backup safety, and production boundaries |
| [API](docs/api/2026-07-30/api.md) | Route overview, authentication, health check, and OpenAPI access |
| [Development](docs/development/2026-07-28/development.md) | Scripts, lockfile policy, project structure, translations, and preview capture |
| [OpenAPI specification](docs/api/2026-07-30/openapi.yaml) | Full OpenAPI 3.1 document |

## Common commands

```bash
npm run dev       # Start the server and open a private/incognito browser window
npm run secrets:generate # Print independent 32-byte JWT and MFA secrets
npm test          # Run the test suite
npm run build     # Integrity-vendor Mermaid, then compile TypeScript
npm run reproduce:cross-instance-loss # Reproduce the stale-room compaction loss and fixed behavior
npm run reproduce:attachment-position-loss # Reproduce stale-SQL attachment position loss and the fixed merge
npm run reproduce:page-cover-backup-manifest # Reproduce inline-cover manifest exhaustion and the v2 fix
npm run reproduce:backup-workspace-state-loss # Reproduce v3 page-history/navigation loss and the v4 correction
npm run reproduce:page-cover-operation-scope # Reproduce picker-cancel and cross-page draft races
npm run reproduce:page-cover-pdf-layout # Reproduce full-bleed PDF measurement regression
npm run reproduce:block-preserve-children-delete # Reproduce partial hierarchy commit and atomic rollback
npm run reproduce:block-delete-response-loss # Reproduce committed-delete response loss and idempotent acknowledgement
npm run reproduce:passkey-direct-login # Generate a P-256 assertion and replay the passkey-login attack matrix
npm run verify:collaboration # Check collaboration wiring, protocol behavior, and source syntax
npm run verify:data-loss # Check persistence and recovery integrity guards
npm start         # Run the compiled server
```

Before a production deployment, provide explicit unique secrets, configure the browser origins, leave registration disabled unless it is intentionally required, and serve the app over HTTPS in a browser that supports Web Locks so safety-critical cross-tab transitions can run. To let BrainVault serve Posh-ACME's `fullchain.cer` and `cert.key` directly, use `HTTPS_MODE=posh-acme` and set `POSH_ACME_CERT_PATH`. For TLS termination in Caddy, Synology DSM, NGINX, or Nginx Proxy Manager, use `HTTPS_MODE=proxy`. Follow the [HTTPS deployment guide](deploy/README.md), then see [Security](docs/security/2026-07-30/security.md) and [Configuration](docs/configuration/2026-07-28/configuration.md).

## Security update: deployment requirements (2026-09-17)

Apply migration `080_registration_approval.sql` with `npm run db:migrate` before starting this revision, including deployments with `AUTO_BOOTSTRAP_DATABASE=false`. Existing accounts remain approved. When `REGISTRATION_ENABLED=true`, new public registrations receive the same generic response but cannot authenticate until an operator independently verifies the applicant and runs:

```bash
npm run registration:approve -- <username>
```

Collection administrators retain member-page administration, but only the workspace owner can permanently delete a collection root or create/revoke a direct page grant. Non-owner recovery uploads remain download-only, are labeled untrusted, and have separate bounded quotas. A recovery upload is not proof that its contents predate revocation.

IPv6 bookmark fetching now requires successful RFC 7050 prefix discovery even when `BOOKMARK_FETCH_NAT64_PREFIXES` is configured. Unknown discovery drops IPv6 candidates; safe IPv4 candidates remain usable. No new bookmark-host allowlist is introduced. Public-origin DNS is refreshed after 60 seconds, and local interfaces are checked on every validation.

`COLLABORATION_ROOM_MEMORY_MAX_BYTES` defaults to 536870912 (512 MiB) of conservative process-wide room/replay reservations. Separate 128 MiB ceilings cover receive-buffer capacity, fragments, and queued/active message payloads. These are application accounting limits, not a guarantee of total RSS; retain an operating-system/container memory limit. Capacity exhaustion is retryable. Partial WebSocket frames have an absolute 15-second completion deadline.

The focused regression suite is included in `verify:security` and can also be run directly:

```bash
node --import=tsx --test tests/security-assessment-remediation.node.test.mjs
```

Use a Node.js version satisfying the unchanged `package.json` engine requirement and install the locked dependencies. Before production rollout, run `npm run build`, `npm test`, and `npm run verify:security`, then validate the migration and parallel TOTP behavior against the deployment's MariaDB instance. The focused suite contains deterministic transaction simulations, not live database concurrency or translator integration tests.

## Maintenance and audit notes

Detailed dated remediation and recovery reviews are kept under `docs/` so this README stays focused on setup and day-to-day use:

- [Security report remediation (2026-09-13)](docs/security/2026-09-13/security-report-remediation.md)
- Recovery maintenance (2026-09-11): [initial review](docs/recovery/2026-09-11/recovery-maintenance-review.md), [durability barrier](docs/recovery/2026-09-11/recovery-durability-barrier-maintenance.md), [queued cleanup integrity](docs/recovery/2026-09-11/queued-recovery-cleanup-integrity.md), and [legacy cleanup audit](docs/recovery/2026-09-11/legacy-recovery-cleanup-audit.md)
