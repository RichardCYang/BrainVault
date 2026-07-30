# API

Most API routes require a bearer token returned by the register or login endpoint. Accounts with MFA enabled receive a temporary MFA session during login and obtain the normal access token after completing a TOTP or passkey challenge.

## Route overview

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
| `GET` | `/api/pages/:pageId/shares` | List invited editors; owner only |
| `POST` | `/api/pages/:pageId/shares` | Add an existing user as an editor; owner only |
| `DELETE` | `/api/pages/:pageId/shares/:userId` | Remove an editor and close that user’s active sockets; owner only |
| `POST` | `/api/pages/:pageId/collaboration/session` | Issue a short-lived page-scoped WebSocket ticket and canonical snapshot; requires `{ "documentEpochProtocol": 2 }` |
| `PUT` | `/api/pages/:pageId/collaboration/snapshot` | Materialize the locked durable Yjs log into page/block tables; request content is not trusted |
| `WS` | `/api/collaboration/:pageId` | Authenticated binary Yjs updates plus JSON presence/control messages |
| `POST` | `/api/pages/:pageId/blocks` | Add a non-attachment block |
| `POST` | `/api/bookmarks/preview` | Fetch sanitized OpenGraph metadata for a public web page URL |
| `POST` | `/api/pages/:pageId/attachments` | Upload a file and create an attachment block |
| `PATCH` | `/api/blocks/:blockId` | Update a block |
| `DELETE` | `/api/blocks/:blockId` | Delete a block and its descendants, including stored attachment files |
| `GET` | `/api/blocks/:blockId/attachment` | Download an attachment after current page-access verification |
| `GET` | `/api/data/export` | Stream a complete ZIP backup of the authenticated workspace, including page sharing grants by collaborator login ID |
| `POST` | `/api/data/import` | Validate and restore a BrainVault backup ZIP; current-format grants are recreated and legacy grants for matching page IDs are preserved |
| `POST` | `/api/pages/:pageId/blocks/reorder` | Move or reorder blocks |
| `GET` | `/api/pages/:pageId/render` | Render sanitized page HTML |
| `GET` | `/api/search?q=...` | Search titles and block Markdown |


## Backup sharing integrity

Current-format manifests include `data.pageShares` entries containing the page ID, normalized collaborator login ID, `EDIT` permission, and creation timestamp. Import resolves every collaborator under a database lock before destructive replacement. A missing account, self-share, duplicate grant, collection target, or unknown page causes a validation failure with no data replacement. An archived ordinary page may carry a retained grant because archiving suspends live collaboration without deleting the access list; restore preserves that grant for a later unarchive.

Backups created before `pageShares` was added remain accepted. During those legacy restores, BrainVault snapshots the existing grants and reinserts the ones whose ordinary page IDs survive, including archived pages with retained grants, rather than losing them through the `pages` → `page_shares` cascade. The import response reports `counts.shares` and `sharing.mode` (`backup` or `legacy-preserved`).

## Collaboration materialization integrity

`PUT /api/pages/:pageId/collaboration/snapshot` accepts only the current `documentEpoch` and exact latest `updateId` as meaningful inputs. The update ID is a synchronization checkpoint, not a binding between the request body and the document contents. While holding the same page lock used by WebSocket writers, the server reads `page_yjs_updates` in update order, reconstructs the Yjs document, validates its title, blocks, hierarchy, JSON-safe metadata, and attachment tombstones, and writes only that server-derived state to `pages` and `blocks`.

For rollout compatibility, older tabs may still send `title`, `blocks`, or `deletedAttachmentIds`; those unknown fields are stripped and ignored. Migration `022_server_authoritative_collaboration_materialization.sql` marks pre-fix materialization checkpoints as provenance version `0`. A non-empty collaboration history must be rematerialized by the updated server before final-share removal, archive, permanent deletion, export, or workspace restore can proceed.

## OpenAPI

The complete OpenAPI 3.1 document is stored at [`docs/api/2026-07-30/openapi.yaml`](openapi.yaml) and served by a running application at:

```text
http://localhost:4000/docs/api/2026-07-30/openapi.yaml
```

## Health check

The health endpoint is available without authentication:

```bash
curl http://localhost:4000/health
```

## WebSocket details

The collaboration session response supplies the socket path and two required subprotocol values: `brainvault-yjs-v2` and a short-lived `brainvault-ticket.<token>` credential. Binary messages carry ordered Yjs updates; JSON messages carry readiness acknowledgements, presence, access changes, and canonical attachment notifications. See [Collaboration](../../collaboration/2026-07-29/collaboration.md) for the protocol and deployment requirements.
