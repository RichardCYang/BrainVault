# Page and collection sharing and real-time collaboration

BrainVault supports two sharing scopes. An ordinary page can be shared directly with an existing account using a page-level `EDIT` grant, while a **custom collection** can be shared with `READ`, `WRITE`, or `ADMIN` permission. Shared ordinary documents use the same Yjs collaboration and recovery machinery regardless of which grant made the document accessible.

Archived pages cannot open live collaboration or accept a new direct page grant, but archiving preserves existing access grants while live collaboration is suspended so restoring the page can reactivate access. The virtual **Default Collection** is not a shareable collection object; collection sharing applies to persisted custom collections.

## Collection sharing and permissions

Open a custom collection by clicking its **name** in the sidebar. In the collection landing view, the owner and `ADMIN` collection collaborators see **Share collection** next to **Add page**. The button is hidden for the Default Collection, while an individual document is open, and for `READ`/`WRITE` collaborators.

A collection grant is inherited by the collection and every document page whose materialized membership belongs to that collection, including nested descendant pages. Creating a page inside the collection inherits the current grants. Moving a page subtree into or out of the collection changes the applicable collection grant and replaces any affected collaboration lineage so a stale room cannot retain access from the previous membership.

| Permission | Effective role | Main capabilities |
| --- | --- | --- |
| `READ` | `READER` | Navigate the collection and read its documents. A read-only client can receive live Yjs state, but binary writes are rejected with `COLLABORATION_READ_ONLY`. |
| `WRITE` | `EDITOR` | Read plus edit shared document titles/blocks and other writable document content. It cannot manage sharing or page administration. |
| `ADMIN` | `ADMIN` | Read/write plus sharing and page/collection administration within the collection scope. An administrator cannot move pages outside the shared collection. |

For the same user, a collection grant is authoritative before a direct page grant. This includes a `READ` collection grant overriding a stored direct `EDIT` grant on a member page. When collection access is removed, a still-valid direct grant can become authoritative again; grant generations and targeted socket disconnects prevent a delayed cleanup from revoking that revived access.

The collection record itself is not a Yjs collaborative document. Yjs sessions run on ordinary member pages. Collection metadata and sharing administration use authenticated REST mutations.

For a focused guide to the UI entry point, role behavior, inheritance, API routes, backup/restore, and common reasons the button may be missing, see [Collection sharing](../2026-09-02/collection-sharing.md).

## Collaboration flow

1. Sharing is configured either from an ordinary page's **Share** dialog (`page_shares`, direct `EDIT`) or from a custom collection's **Share collection** dialog (`collection_shares`, `READ`/`WRITE`/`ADMIN`).
2. An authorized owner or invited editor requests `POST /api/pages/:pageId/collaboration/session` with `{ "documentEpochProtocol": 2 }`.
3. The server returns a short-lived, page-scoped WebSocket ticket, the canonical database snapshot, the current `documentEpoch`, the socket path, and the required `brainvault-yjs-v2` subprotocol.
4. The browser loads only local recovery updates carrying that exact `documentEpoch`, then creates the Yjs document containing the page title, blocks, block ordering, metadata, and attachment-deletion tombstones. Recovery updates from an older or unknown generation remain in browser storage for manual recovery and are never merged automatically.
5. Binary Yjs updates are sent through the authenticated `/api/collaboration/:pageId` WebSocket endpoint. The server applies each untrusted update to an isolated Yjs document, rejects malformed or over-sized state, stores the accepted update in MariaDB, and only then swaps the live room state, acknowledges, and broadcasts it.
6. Presence messages show active collaborators and the block/field they are editing. Presence is ephemeral and is not written to the database.
7. The browser periodically materializes a consistent Yjs snapshot back into the normal `pages` and `blocks` tables. Existing REST reads, search, render, export, and backup therefore continue to use the canonical relational representation.

The first collaborator to join a newly shared page bootstraps the Yjs history from the server-provided database snapshot. Other clients wait for that accepted update, preventing separate initial histories. Reconnection replays persisted history and resends any local document state whose acknowledgement was lost during a disconnect.

## Persistence and consistency

Migration `020_page_sharing_yjs_collaboration.sql` adds:

- `page_shares` for owner-managed editor grants
- `page_yjs_updates` for ordered binary document updates
- `page_collaboration_state` for the last relational materialization marker

Migration `021_collaboration_document_epoch.sql` adds a non-null `document_epoch` to `page_collaboration_state`. The epoch is renewed whenever collaboration history is intentionally reset, including disabling and re-enabling sharing. Session tickets, WebSocket rooms, persisted updates, relational snapshots, and browser recovery records are all bound to that epoch.

Migration `022_server_authoritative_collaboration_materialization.sql` adds `materialization_version`. Existing rows default to version `0`, which means an older build may have advanced the update marker from a browser-supplied duplicate snapshot. Version `1` is written only after the updated server reconstructs the relational state from the durable Yjs log. For any non-empty history, destructive and replacement operations require both an exact latest update marker and the current provenance version.

Migration `068_collection_sharing.sql` adds `collection_shares` with `READ`/`WRITE`/`ADMIN` permissions and per-grant generations, plus `page_collection_memberships` to materialize the custom collection that governs each page. The migration backfills membership recursively from the existing page hierarchy. Runtime create/move/restore paths keep that materialized membership synchronized.

A materialization request includes only the server-issued document epoch and the last received update ID as meaningful inputs. The update ID is a checkpoint, not proof that independently supplied title or block data belongs to that update. The server locks the page and Yjs history, rejects a replaced generation or stale checkpoint, replays ordered `page_yjs_updates`, decodes and validates the reconstructed document, gives attachment-deletion tombstones precedence over concurrent stale attachment maps, prevents forged attachment blocks, writes the title and blocks in one transaction, and finally records update ID plus provenance version. Legacy browser fields are ignored. Compaction persists a full state update re-encoded by the server-side Yjs document and removes older update rows only after the replacement update is committed.

Every normal update and compaction write also holds the page and collaboration-state row locks while comparing the room's in-memory `maxUpdateId` with the durable `MAX(page_yjs_updates.id)`. A process-local room that missed an update committed by another application process is invalidated before any insert or history deletion. Connected clients receive close code `1011`, reconnect, replay durable history, and resend their still-unacknowledged full-document recovery state. Snapshot writes retain the additional exact `baseUpdateId` check. This is a fail-closed integrity fence; it does not provide cross-process live fan-out.

When the final effective share for an ordinary document is removed, BrainVault requires the latest accepted Yjs update to be materialized by the current server implementation before deleting collaboration history. The same provenance gate protects archive, permanent deletion, export, and workspace restore. Removing or changing a collaborator grant immediately invalidates the affected grant generation and closes matching active sockets. Archiving closes the entire room but preserves the grants while live collaboration is suspended; permanent deletion removes the page and its grants.

## Document replacement and offline recovery

A full workspace restore, the final share removal, or a later first share can reuse the same page ID while intentionally replacing its Yjs history. Page ID alone therefore is not a safe recovery boundary. BrainVault uses `documentEpoch` as a generation fence:

- the HTTP session response and signed WebSocket ticket carry the current epoch;
- the WebSocket upgrade validates it before joining a room;
- every database write rechecks it while holding the page/state row locks;
- snapshot materialization requires the same epoch;
- local browser recovery keys contain both epoch and source tab ID; and
- legacy or mismatched recovery records remain visible as separate recovery groups instead of being merged or overwritten.

A connected client receives WebSocket close code `4011` when the document generation changes. Its unacknowledged local state remains in the generation-specific browser recovery record before the page reloads. Session creation requires `documentEpochProtocol: 2`, and the WebSocket upgrade requires `brainvault-yjs-v2`. Together these version fences prevent a cached pre-fix tab—or a ticket issued immediately before a rolling restart—from reconnecting to the patched writer and republishing stale SQL attachment positions. Refreshing loads the compatible client while preserving older browser recovery records for manual inspection.

## Authentication and network requirements

The WebSocket ticket is a short-lived JWT with the authenticated user ID, page ID, and document epoch. It is sent as a dedicated WebSocket subprotocol rather than in the URL. The upgrade handler checks:

- the exact collaboration path and page ID
- the browser `Origin` against the configured same-origin/CORS policy
- RFC 6455 version, key, protocol, masking, frame, and message limits
- current page access before upgrade and again at intervals while connected
- per-connection frame and byte-rate limits

Direct Posh-ACME mode accepts secure WebSocket upgrades on the native HTTPS listener. Production reverse proxies must forward WebSocket upgrades for `/api/collaboration/` and preserve `Origin`, `Host`/`X-Forwarded-Host`, and `X-Forwarded-Proto`.

The built-in room fan-out is process-local. BrainVault enforces one active application process per MariaDB database with a database-scoped startup lease, so an accidental second process fails before accepting network traffic. A multi-process or multi-host deployment remains unsupported until shared rate/admission stores, a shared pub/sub backplane, and distributed room/update coordination are implemented.

In proxy mode, the directly connected proxy must match `TRUST_PROXY_ADDRESSES`. Numeric hop trust is rejected. BrainVault recognizes only one canonical `X-Forwarded-Proto: https` value from that peer, keeps secure session cookies, and derives `wss:` browser connections from the public page URL. Plain backend HTTP requests are redirected to fixed `PUBLIC_ORIGIN` or rejected, depending on `HTTPS_REDIRECT`. In Posh-ACME mode, the listener itself is HTTPS and no forwarded-protocol trust is needed.

Direct Posh-ACME plus complete Caddy, NGINX, Nginx Proxy Manager, and Synology DSM configurations are provided in the repository [HTTPS deployment guide](../../../deploy/README.md). The included NGINX example forwards WebSocket upgrade headers on the shared location, so both normal API requests and `/api/collaboration/` use the same backend port.

The browser loads the pinned `yjs@13.6.31` ESM build from `/vendor/yjs/yjs.mjs`. BrainVault exposes only JavaScript module files from the lockfile-controlled `yjs`, `lib0`, and `isomorphic.js` packages, and an inline import map with a CSP hash resolves Yjs bare module specifiers to those same-origin routes. No third-party Yjs CDN access is required. Because these same-origin module URLs are stable rather than content-versioned, their responses require revalidation on reuse instead of using long-lived `immutable` caching; this prevents a newly loaded tab from retaining a pre-deployment collaboration runtime.

## Verification

Run the collaboration-specific deterministic checks with Node.js 22.23.2 or newer within the 22.x line, Node.js 24.18.1 or newer within the 24.x line, or Node.js 26.5.1 or newer:

```bash
npm run reproduce:materialization-loss
npm run reproduce:cross-instance-loss
npm run reproduce:recovery-write-loss
npm run reproduce:attachment-position-loss
npm run test:durability
npm run verify:collaboration
npm run verify:data-loss
```

The materialization reproduction proves that relational truth is rebuilt from locked durable Yjs history. The cross-instance reproduction proves that a stale process-local room cannot append or compact over a newer durable tip. The recovery-write reproduction verifies durable-before-visible browser edits. The attachment-position reproduction proves that reconnecting before relational materialization no longer republishes stale SQL parent/order fields over an acknowledged Yjs move, while canonical file metadata remains server-owned. The collaboration verifier checks all four loss schedules, protocol-version fencing, source wiring, exact Yjs dependency pins and integrity, materialization provenance, durable-room freshness, all executable project JavaScript/TypeScript syntax, block hierarchy invariants, the RFC 6455 handshake accept value, masked text and binary frames, fragmented messages, Ping/Pong behavior, JSON server frames, and rejection of an unmasked client frame. The Vitest suite also contains server-side Yjs merge, materialization, isolation, malformed-update, size-limit, and write-checkpoint tests.

The normal project checks remain:

```bash
npm run build
npm test
```
