# Page sharing and real-time collaboration

BrainVault page owners can share an ordinary page with another existing BrainVault account by login ID. The owner and every invited editor can then edit the page title and block document at the same time.

Collections and archived pages cannot be shared. Only the page owner can add or remove collaborators, archive the page, change page-level navigation metadata, or permanently delete the page. Invited editors can read and edit the shared page and use its authenticated attachment upload/download flow, but they cannot manage access.

## Collaboration flow

1. The owner opens **Share**, enters an existing login ID, and creates an `EDIT` grant in `page_shares`.
2. An authorized owner or invited editor requests `POST /api/pages/:pageId/collaboration/session`.
3. The server returns a short-lived, page-scoped WebSocket ticket, the canonical database snapshot, the socket path, and the required subprotocol names.
4. The browser creates a Yjs document containing the page title, blocks, block ordering, metadata, and attachment-deletion tombstones.
5. Binary Yjs updates are sent through the authenticated `/api/collaboration/:pageId` WebSocket endpoint. The server applies each untrusted update to an isolated Yjs document, rejects malformed or over-sized state, stores the accepted update in MariaDB, and only then swaps the live room state, acknowledges, and broadcasts it.
6. Presence messages show active collaborators and the block/field they are editing. Presence is ephemeral and is not written to the database.
7. The browser periodically materializes a consistent Yjs snapshot back into the normal `pages` and `blocks` tables. Existing REST reads, search, render, export, and backup therefore continue to use the canonical relational representation.

The first collaborator to join a newly shared page bootstraps the Yjs history from the server-provided database snapshot. Other clients wait for that accepted update, preventing separate initial histories. Reconnection replays persisted history and resends any local document state whose acknowledgement was lost during a disconnect.

## Persistence and consistency

Migration `020_page_sharing_yjs_collaboration.sql` adds:

- `page_shares` for owner-managed editor grants
- `page_yjs_updates` for ordered binary document updates
- `page_collaboration_state` for the last relational materialization marker

A materialization request includes the last received update ID. The server locks the page, rejects stale snapshots, validates block IDs and hierarchy, gives attachment-deletion tombstones precedence over concurrent stale attachment maps, prevents forged attachment blocks, writes the title and blocks in one transaction, and then records the materialized update ID. Compaction persists a full state update re-encoded by the server-side Yjs document and removes older update rows only after the replacement update is committed.

When the last editor grant is removed, BrainVault requires the latest accepted Yjs update to be materialized before deleting collaboration history. Removing a collaborator immediately closes that user's active sockets. Archiving or deleting a page closes the entire room.

## Authentication and network requirements

The WebSocket ticket is a short-lived JWT with the authenticated user ID and page ID. It is sent as a dedicated WebSocket subprotocol rather than in the URL. The upgrade handler checks:

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
npm run verify:collaboration
```

The script checks source wiring, exact Yjs dependency pins and integrity, all executable project JavaScript/TypeScript syntax, block hierarchy invariants, the RFC 6455 handshake accept value, masked text and binary frames, fragmented messages, Ping/Pong behavior, JSON server frames, and rejection of an unmasked client frame. The Vitest suite also contains server-side Yjs merge, isolation, malformed-update, and size-limit tests.

The normal project checks remain:

```bash
npm run build
npm test
```
