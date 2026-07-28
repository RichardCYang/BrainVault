# Page sharing and real-time collaboration

BrainVault page owners can share an ordinary page with another existing BrainVault account by login ID. The owner and every invited editor can then edit the page title and block document at the same time.

Collections and archived pages cannot be shared. Only the page owner can add or remove collaborators, archive the page, change page-level navigation metadata, or permanently delete the page. Invited editors can read and edit the shared page and use its authenticated attachment upload/download flow, but they cannot manage access.

## Collaboration flow

1. The owner opens **Share**, enters an existing login ID, and creates an `EDIT` grant in `page_shares`.
2. An authorized owner or invited editor requests `POST /api/pages/:pageId/collaboration/session` with `{ "documentEpochProtocol": 1 }`.
3. The server returns a short-lived, page-scoped WebSocket ticket, the canonical database snapshot, the current `documentEpoch`, the socket path, and the required subprotocol names.
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

A materialization request includes only the server-issued document epoch and the last received update ID as meaningful inputs. The update ID is a checkpoint, not proof that independently supplied title or block data belongs to that update. The server locks the page and Yjs history, rejects a replaced generation or stale checkpoint, replays ordered `page_yjs_updates`, decodes and validates the reconstructed document, gives attachment-deletion tombstones precedence over concurrent stale attachment maps, prevents forged attachment blocks, writes the title and blocks in one transaction, and finally records update ID plus provenance version. Legacy browser fields are ignored. Compaction persists a full state update re-encoded by the server-side Yjs document and removes older update rows only after the replacement update is committed.

When the last editor grant is removed, BrainVault requires the latest accepted Yjs update to be materialized by the current server implementation before deleting collaboration history. The same provenance gate protects archive, permanent deletion, export, and workspace restore. Removing a collaborator immediately closes that user's active sockets. Archiving or deleting a page closes the entire room.

## Document replacement and offline recovery

A full workspace restore, the final share removal, or a later first share can reuse the same page ID while intentionally replacing its Yjs history. Page ID alone therefore is not a safe recovery boundary. BrainVault uses `documentEpoch` as a generation fence:

- the HTTP session response and signed WebSocket ticket carry the current epoch;
- the WebSocket upgrade validates it before joining a room;
- every database write rechecks it while holding the page/state row locks;
- snapshot materialization requires the same epoch;
- local browser recovery keys contain both epoch and source tab ID; and
- legacy or mismatched recovery records remain visible as separate recovery groups instead of being merged or overwritten.

A connected client receives WebSocket close code `4011` when the document generation changes. Its unacknowledged local state remains in the generation-specific browser recovery record before the page reloads. Session creation also requires `documentEpochProtocol: 1`; a tab running pre-fix JavaScript cannot obtain a new ticket and replay an unversioned recovery copy after deployment. Refreshing that tab loads the generation-aware client while preserving its legacy browser recovery record for manual inspection.

## Authentication and network requirements

The WebSocket ticket is a short-lived JWT with the authenticated user ID, page ID, and document epoch. It is sent as a dedicated WebSocket subprotocol rather than in the URL. The upgrade handler checks:

- the exact collaboration path and page ID
- the browser `Origin` against the configured same-origin/CORS policy
- RFC 6455 version, key, protocol, masking, frame, and message limits
- current page access before upgrade and again at intervals while connected
- per-connection frame and byte-rate limits

Production reverse proxies must forward WebSocket upgrades for `/api/collaboration/` and preserve `Origin`, `Host`/`X-Forwarded-Host`, and `X-Forwarded-Proto`.

The built-in room fan-out is process-local. Run one BrainVault application process for this implementation. A multi-process or multi-host deployment requires a shared pub/sub backplane and distributed room/update coordination before enabling collaboration across instances.

Example Nginx location:

```nginx
location /api/collaboration/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

The browser module imports the pinned Yjs ESM build at `yjs@13.6.31` from jsDelivr. A deployment with a restrictive outbound or browser content policy must allow that exact CDN resource, or vendor the same version locally and update the import plus Content Security Policy together.

## Verification

Run the collaboration-specific deterministic checks with Node.js 22.13 or newer:

```bash
npm run reproduce:materialization-loss
npm run verify:collaboration
npm run verify:data-loss
```

The reproduction reads the vulnerable route from the preserved Git `HEAD`, demonstrates how a same-ID forged empty body could become SQL truth and authorize history deletion, and then verifies the working tree's server-derived path and legacy-checkpoint fence. The collaboration verifier checks source wiring, exact Yjs dependency pins and integrity, materialization provenance, all executable project JavaScript/TypeScript syntax, block hierarchy invariants, the RFC 6455 handshake accept value, masked text and binary frames, fragmented messages, Ping/Pong behavior, JSON server frames, and rejection of an unmasked client frame. The Vitest suite also contains server-side Yjs merge, materialization, isolation, malformed-update, and size-limit tests.

The normal project checks remain:

```bash
npm run build
npm test
```
