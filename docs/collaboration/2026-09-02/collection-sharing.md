# Collection sharing

BrainVault supports collection-level access for **custom collections**. A collection grant applies to the collection and to every ordinary page that belongs to that collection, including nested descendant pages. The feature is implemented end to end in the browser UI, REST API, MariaDB migrations, effective-access resolver, Yjs collaboration server, backup/restore path, and durability tests.

## Finding **Share collection** in the UI

The collection-sharing entry point is intentionally contextual rather than global:

1. Sign in as the collection owner or a collaborator with `ADMIN` permission.
2. In the left sidebar, click the **name of a custom collection**. Do not open one of its document pages.
3. In the collection landing view, select **Share collection** next to **Add page**.
4. Enter an existing BrainVault login ID and choose `READ`, `WRITE`, or `ADMIN`.

The button is hidden when any of the following is true:

- the current view is the virtual **Default Collection**;
- an individual document page is open instead of the collection landing view;
- the signed-in account has only `READ` or `WRITE` permission; or
- the active item is not a persisted custom collection.

The sidebar collection three-dot menu is not the sharing entry point. Direct sharing for one ordinary page remains available from that page's **Share** button.

## Permission model

| Permission | Effective page role | Read documents | Edit shared documents | Manage page/collection operations | Manage sharing |
| --- | --- | --- | --- | --- | --- |
| `READ` | `READER` | Yes | No | No | No |
| `WRITE` | `EDITOR` | Yes | Yes | No | No |
| `ADMIN` | `ADMIN` | Yes | Yes | Yes, within the shared collection scope | Yes |

`READ` clients can join the live Yjs stream for an already shared ordinary page and receive current/future document updates, but the WebSocket server marks the connection non-writable and rejects binary document writes with `COLLABORATION_READ_ONLY`.

`WRITE` allows normal shared-document editing but does not expose sharing administration or page-management controls.

`ADMIN` is deliberately stronger. It satisfies the administration checks needed for collection sharing and supported page/collection management operations within the shared collection. Direct page-share creation remains owner-only so a collection administrator cannot mint a lower-priority grant that outlives the authorizing collection grant. A collection administrator is scope-limited: moving a page outside the shared collection is rejected with `COLLECTION_ADMIN_SCOPE_REQUIRED`.

## Scope and inheritance

Migration `068_collection_sharing.sql` creates two structures:

- `collection_shares`: one `(collection_id, user_id)` grant with `READ`, `WRITE`, or `ADMIN`, `shared_by`, and a causal `generation` token;
- `page_collection_memberships`: the materialized custom-collection membership for the collection itself and every descendant page.

A collection is a root object; pages under it may be nested. Membership is recursive, so a grant reaches descendant pages rather than only direct children.

When pages are created under a collection, their membership is written immediately. When a page subtree is moved, BrainVault replaces membership for that subtree. If moving changes the effective sharing set, the server fences active writes, preserves recovery candidates, resets the affected Yjs document generation, and disconnects only the superseded collaboration lineage.

## Collection grant versus direct page grant

For a user who has both kinds of access to the same member page, the collection grant is authoritative. The effective-access resolver checks `collection_shares` before `page_shares`.

This means:

- collection `READ` + direct page `EDIT` => effective `READER` while the collection grant exists;
- collection `WRITE` + direct page `EDIT` => effective `EDITOR` from the collection grant;
- collection `ADMIN` + direct page `EDIT` => effective `ADMIN` from the collection grant.

An independent direct page grant created by the workspace owner can remain stored underneath the collection grant. BrainVault rotates its generation when collection sharing supersedes it so delayed socket cleanup cannot evict a later session. If the collection grant is removed and the owner-created direct grant is still valid, that direct page grant can become effective again. When a collection administrator is revoked, BrainVault also removes direct page grants on member pages whose `shared_by` provenance identifies that revoked administrator; this prevents administrator-planted grants from surviving the revocation.

## REST API

All endpoints require the normal authenticated BrainVault session. Collection sharing can be managed by the collection owner or an account whose effective role on that collection is `ADMIN`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/collections/:collectionId/shares` | List current collection grants. |
| `POST` | `/api/collections/:collectionId/shares` | Add an existing account with `READ`, `WRITE`, or `ADMIN`. |
| `PATCH` | `/api/collections/:collectionId/shares/:userId` | Change a grant's permission using its current `expectedGeneration`. |
| `DELETE` | `/api/collections/:collectionId/shares/:userId` | Remove a grant using its current `expectedGeneration`. |

Example create body:

```json
{
  "username": "collaborator-id",
  "permission": "WRITE"
}
```

Example update body:

```json
{
  "permission": "ADMIN",
  "expectedGeneration": "cshare_current_generation"
}
```

Example remove body:

```json
{
  "expectedGeneration": "cshare_current_generation"
}
```

The generation is a causal token. If another session has already changed the grant, stale update/remove requests fail with `409 COLLECTION_SHARE_GENERATION_CHANGED` instead of mutating a replacement grant.

## Live collaboration behavior

Collection sharing turns each effectively shared **ordinary document** into the same collaboration model used by direct page sharing. The collection itself is not a Yjs document.

For a document that receives its first effective collaborator, BrainVault starts a fresh collaboration lineage from the canonical SQL snapshot. Writable owners/`WRITE`/`ADMIN` users can submit Yjs updates. `READ` users receive the synchronized state but cannot write it. Permission downgrade or revocation preserves recovery admissions before the old write authority is disconnected.

Removing a collection grant does not blindly disable collaboration for every member page. The server first removes any member-page direct grants created by the revoked administrator, then recalculates effective shares per page, including independent owner-created direct grants. It tears down a document's collaboration history only when its final effective share is gone and all accepted Yjs updates have been safely materialized.

## Backup and restore

Current version 4 backups can include `data.collectionShares` alongside `data.pageShares`. Collection records preserve the collection ID, stable collaborator account ID, username, permission, and creation time. Restore validates the collaborator identity before destructive workspace replacement, rebuilds `page_collection_memberships`, and recreates collection grants with fresh generations.

For older version 4 archives that predate explicit `collectionShares`, BrainVault preserves currently valid collection grants for collection IDs that survive the restore rather than silently deleting them. Backups from versions before v4 cannot declare collection-share data.

## Troubleshooting

### The button is missing

First confirm that you clicked the **custom collection name** and are looking at the collection landing view. The most common cases are opening a document inside the collection, using the Default Collection, or being signed in with `READ`/`WRITE` instead of owner/`ADMIN` access.

### A direct page editor became read-only

Check whether that account also has a collection-level `READ` grant. Collection permissions are authoritative for member pages, so `READ` intentionally overrides a direct page `EDIT` grant while the collection grant exists.

### A permission change returns 409

Refresh/reopen the sharing dialog and retry using the latest grant generation. Permission changes and removals are generation-checked so stale browser actions cannot overwrite a newer access decision.

### Removing access is blocked by pending collaboration work

BrainVault fails closed when collaboration writes are still admitted or the latest accepted Yjs state has not been materialized safely. Allow the active document to synchronize/materialize, then retry the sharing change.

## Implementation and verification references

The main implementation files are:

- `migrations/068_collection_sharing.sql`
- `src/lib/page-access.ts`
- `src/lib/collection-membership.ts`
- `src/routes/collection-sharing.routes.ts`
- `src/lib/collaboration-server.ts`
- `public/index.html`
- `public/app.js`
- `src/lib/data-transfer.ts`
- `tests/collection-sharing.node.test.mjs`

The focused dependency-free checks can be run with:

```bash
node --test tests/collection-sharing.node.test.mjs
```

For the broader real-time collaboration checks, use `npm run verify:collaboration` and the normal test suite documented in the root README.
