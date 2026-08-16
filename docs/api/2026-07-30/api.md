# API

Most API routes use the `HttpOnly`, `SameSite=Strict` `brainvault_session` cookie. The cookie is `Secure` for configured HTTPS deployments, and compatibility bearer sessions default to disabled in production. Password, direct-passkey, and MFA completion never return the JWT in JSON, and the built-in browser client never stores it in `localStorage`. Accounts with MFA enabled receive a temporary opaque MFA session during password login and receive the normal authentication cookie only after completing a TOTP or passkey challenge. A discoverable passkey can instead complete the separate username-less primary login ceremony directly from the sign-in screen.

## Route overview

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Submit account creation; always returns the same accepted response for valid new or existing IDs |
| `POST` | `/api/auth/login` | Sign in; returns either a cookie-authenticated user response or a temporary MFA session |
| `POST` | `/api/auth/passkey/options` | Create username-less discoverable-passkey options and a browser-bound one-time challenge token |
| `POST` | `/api/auth/passkey/verify` | Verify the discoverable passkey and create the normal `HttpOnly` session cookie |
| `POST` | `/api/auth/logout` | Revoke the account authentication generation and clear the browser session cookie |
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
| `GET` | `/api/auth/login-history?months=3` | Read the current user’s successful and failed login attempts, newest first; accepts 1–12 months |
| `PATCH` | `/api/auth/profile` | Update display name, profile image, or preferred language |
| `POST` | `/api/auth/password` | Change the password after verifying the current password |
| `GET` | `/api/pages` | List pages |
| `POST` | `/api/pages` | Create a page; clients can provide `mutationId` and reuse it only for an exact retry after an ambiguous outcome |
| `GET` | `/api/pages/:pageId` | Read a page and its block tree |
| `PATCH` | `/api/pages/:pageId` | Update page metadata |
| `DELETE` | `/api/pages/:pageId` | Archive or permanently delete a page |
| `GET` | `/api/pages/:pageId/shares` | List invited editors; owner only |
| `POST` | `/api/pages/:pageId/shares` | Add an existing user as an editor; owner only |
| `DELETE` | `/api/pages/:pageId/shares/:userId` | Remove an editor and close that user’s active sockets; owner only |
| `POST` | `/api/pages/:pageId/collaboration/session` | Issue a short-lived page-scoped WebSocket ticket and canonical snapshot; requires `{ "documentEpochProtocol": 2 }` |
| `PUT` | `/api/pages/:pageId/collaboration/snapshot` | Materialize the locked durable Yjs log into page/block tables; request content is not trusted |
| `WS` | `/api/collaboration/:pageId` | Authenticated binary Yjs updates plus JSON presence/control messages |
| `POST` | `/api/pages/:pageId/blocks` | Add a non-attachment block; exact ambiguous retries reuse `mutationId` |
| `POST` | `/api/bookmarks/preview` | Fetch sanitized OpenGraph metadata for a public URL under a dedicated authenticated-user rate limit |
| `POST` | `/api/pages/:pageId/attachments` | Upload a screened file and create an attachment block; access, page state, request size, rate, and concurrency admission are checked before multipart bytes reach temporary storage; exact ambiguous retries reuse `mutationId` |
| `PATCH` | `/api/blocks/:blockId` | Update a block |
| `DELETE` | `/api/blocks/:blockId` | Delete a block and its descendants, including stored attachment files |
| `GET` | `/api/blocks/:blockId/attachment` | Download an attachment after current page-access verification, forced disposition, and active-content response hardening |
| `GET` | `/api/data/export` | Stream a complete ZIP backup under a per-user rate limit, including page sharing grants bound to collaborator account ID and username |
| `POST` | `/api/data/import` | Validate and restore a BrainVault backup ZIP; ID-bound grants are recreated; legacy grants are preserved only through verified current identities |
| `POST` | `/api/pages/:pageId/blocks/reorder` | Move or reorder blocks |
| `GET` | `/api/pages/:pageId/render` | Render sanitized page HTML |
| `GET` | `/api/pages/:pageId/versions` | List owner-only page version history; historical entries may contain deleted content |
| `GET` | `/api/pages/:pageId/versions/:versionId` | Read one owner-only page version entry |
| `DELETE` | `/api/pages/:pageId/versions` | Reset owner-only page version history once using a required idempotency key |
| `GET` | `/api/search?q=...` | Search titles and block Markdown |


## Page-creation retry integrity

`POST /api/pages` accepts an optional `mutationId` (1–64 ASCII letters, digits, `_`, or `-`). The server reserves the owner-scoped mutation receipt in the same transaction as the page, its initial block, tags, and creation-history entry. Retrying the exact same body with the same ID returns the original page. Reusing the ID with different content is rejected with `409 MUTATION_ID_REUSED`. If the original page was later permanently deleted, a replay is rejected rather than silently creating a replacement.

`DELETE /api/pages/:pageId?permanent=true` requires both the latest `expectedSnapshot` and a `mutationId` (1–64 ASCII letters, digits, `_`, or `-`). The deletion receipt is committed in the same transaction as the subtree deletion and intentionally survives the deleted page rows. If the database commit succeeds but the HTTP result is lost, retrying the same request with the same mutation ID returns success without repeating the deletion; reusing the mutation ID for a different request is rejected with `409 MUTATION_ID_REUSED`.

## Block and attachment creation retry integrity

`POST /api/pages/:pageId/blocks` and multipart `POST /api/pages/:pageId/attachments` accept an optional `mutationId` (1–64 ASCII letters, digits, `_`, or `-`). The server reserves `(actor_id, mutation_id)` in the same transaction before inserting a block; attachment requests reserve the receipt before moving the uploaded file to its durable path. An exact retry returns the original block without adding another history entry, advancing the page content version again, or storing another attachment file.

Archived pages are server-side read-only for direct page metadata/tag and block create/update/delete/reorder mutations. Restore the page first; the only page update accepted while archived is a restore-only `PATCH /api/pages/:pageId` with `isArchived: false`. Exact idempotent replays that do not perform a new write remain safe to acknowledge.

Attachment uploads resolve page access, collaboration mode, archive state, declared request size, per-account rate, and process-local concurrency before Multer opens a temporary file. The transaction repeats the authorization and page-state checks after intake so a concurrent ownership, sharing, or archive change fails closed before durable storage or block creation.

The request hash includes the page, block payload, and operation kind. For attachments it also includes the normalized filename, media type, byte size, placement, and SHA-256 digest of the uploaded bytes. Reusing a key with different data is rejected with `409 MUTATION_ID_REUSED`. If the original block was later deleted, replay fails closed with `409 BLOCK_CREATE_REPLAY_UNAVAILABLE` rather than creating a replacement. The browser retries an ambiguous response once and retains the same task key for a later manual retry; authentication changes clear the pending task.

Partial block create/update/attachment requests may also send `basePageContentVersion`, the global page generation of the complete snapshot the browser actually rendered before starting the mutation. The server compares that base while holding the page row lock. It returns `pageContentVersionAuthoritative: true` and the new `pageContentVersion` only when the base was current (or an exact retry proves the committed mutation is the sole intervening generation). Otherwise it returns `pageContentVersionAuthoritative: false` and omits `pageContentVersion`. This prevents a one-block response from falsely certifying unseen changes to other blocks; legacy clients that do not send the base therefore fail conservatively instead of advancing a stale full-page freshness token.

## Block-deletion response-loss integrity

`DELETE /api/blocks/:blockId` accepts an optional `mutationId` (1–64 ASCII letters, digits, `_`, or `-`) alongside the required exact version snapshot. The server stores `(actor_id, mutation_id)`, the normalized request hash, committed page content version, and deleted attachment IDs in the same transaction as the block deletion and version-history entry. The receipt deliberately has no foreign key to the deleted block, so it survives the operation it proves.

If the transaction commits but the HTTP response is lost, an exact retry is acknowledged with `204` without looking up or deleting the already-removed block again. Reusing the ID with a different block or request body is rejected with `409 MUTATION_ID_REUSED`, and malformed or incomplete receipts fail closed rather than repeating a destructive operation. Attachment-file cleanup is replay-safe and runs again after an acknowledged retry, which heals a process interruption between the database commit and filesystem cleanup. The browser keeps the original version snapshot and mutation ID, retries an ambiguous result once, and scopes pending work to the current authentication generation, account, page, block, and preserve/cascade mode.

## Page-version reset retry integrity

`DELETE /api/pages/:pageId/versions` requires a JSON body containing `mutationId` (1–64 ASCII letters, digits, `_`, or `-`). The server locks the owned page, reserves `(owner_id, mutation_id)` before deleting any history, writes the fresh revision-1 baseline, and completes the receipt with `revision` and `deletedCount` in the same transaction.

An exact retry for the same page returns the stored result with `replayed: true` and does not execute a second deletion. Reusing the ID for another page is rejected with `409 MUTATION_ID_REUSED`. This is important when the first transaction commits but its HTTP response is lost: edits recorded after that commit remain intact when the browser retries. Clients must not replace an ambiguous task with a new mutation ID; the built-in browser retries once automatically and retains the same task for a later manual retry.

## Backup sharing integrity

Current-format manifests include `data.pageShares` entries containing the page ID, stable collaborator account ID, collaborator username, `EDIT` permission, and creation timestamp. Import locks destination accounts by ID and requires the ID-and-username pair to match before destructive replacement. A missing or mismatched account, self-share, duplicate grant, mixed identity generation, collection target, or unknown page causes a validation failure with no data replacement. An archived ordinary page may carry a retained grant because archiving suspends live collaboration without deleting the access list; restore preserves that grant for a later unarchive.

Username-only `pageShares` records from the earlier format are accepted only when each record matches a currently locked page-to-account grant in the destination workspace; the importer never discovers a legacy collaborator by username alone. Backups created before `pageShares` existed remain accepted through the separate `legacy-preserved` path: BrainVault snapshots current grants and reinserts those whose ordinary page IDs survive, including archived pages with retained grants, rather than losing them through the `pages` → `page_shares` cascade. The import response reports `counts.shares` and `sharing.mode` (`backup` or `legacy-preserved`).

## Collaboration materialization integrity

`PUT /api/pages/:pageId/collaboration/snapshot` accepts only the current `documentEpoch` and exact latest `updateId` as meaningful inputs. The update ID is a synchronization checkpoint, not a binding between the request body and the document contents. While holding the same page lock used by WebSocket writers, the server reads `page_yjs_updates` in update order, reconstructs the Yjs document, validates its title, blocks, hierarchy, JSON-safe metadata, and attachment tombstones, and writes only that server-derived state to `pages` and `blocks`.

For rollout compatibility, older tabs may still send `title`, `blocks`, or `deletedAttachmentIds`; those unknown fields are stripped and ignored. Migration `022_server_authoritative_collaboration_materialization.sql` marks pre-fix materialization checkpoints as provenance version `0`. A non-empty collaboration history must be rematerialized by the updated server before final-share removal, archive, permanent deletion, export, or workspace restore can proceed.

## OpenAPI

The complete OpenAPI 3.1 document is stored at [`docs/api/2026-07-30/openapi.yaml`](openapi.yaml). Runtime serving of the repository documentation is disabled by default. Setting `SERVE_INTERNAL_DOCS=true` enables `/docs`, but those routes still require an authenticated session.

## Health check

The health endpoint is available without authentication and returns only `{ "ok": true }`:

```bash
curl http://localhost:4000/health
```

## WebSocket details

The collaboration session response supplies the socket path and two required subprotocol values: `brainvault-yjs-v2` and a short-lived `brainvault-ticket.<token>` credential. Binary messages carry ordered Yjs updates; JSON messages carry readiness acknowledgements, presence, access changes, and canonical attachment notifications. See [Collaboration](../../collaboration/2026-07-29/collaboration.md) for the protocol and deployment requirements.
