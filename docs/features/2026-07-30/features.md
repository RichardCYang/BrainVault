# Features

## Workspace and editor

BrainVault uses a page-first workspace with a compact document tree and automatic title saving. A crash-resilient browser draft journal restores unacknowledged title and block edits without overwriting a newer server version.

Pages and collections support Unicode Emoji 17 icons with Korean/English search, categories, skin-tone variants, and recent selections. Pages can be nested, archived, or permanently deleted from their three-dot menus, and search covers page titles and block content.

### Page cover images

Each ordinary page can display a wide cover above its title. Choose one of the five images in `public/img/default_cover`, or upload a PNG, JPEG, or WebP image. The closed picker does not fetch the full-size artwork; compact WebP previews are assigned only when the dialog opens. Browser-side optimization bounds custom covers to 2 MB before the existing page update API stores them, and server validation verifies both the declared image type and its binary signature.

Owners can replace or remove a cover at any time and add it again later. **Reposition** mode supports direct pointer dragging plus horizontal and vertical sliders. The selected focal point is persisted as 0–100 coordinates and rendered with `object-fit: cover` and `object-position`. Cover source and position metadata are included in workspace backup and restore.

## Page sharing and simultaneous editing

Open an ordinary page and select **Share** to add an existing BrainVault account by login ID. The page owner controls the access list; invited users receive edit access to that page but cannot add/remove collaborators, move it in the owner’s hierarchy, archive it, or permanently delete it. Collections cannot be shared. Archived pages cannot start or use live collaboration, but an existing access list is retained and live collaboration becomes available again after the owner restores the page.

While at least one collaborator is configured, the page title and block document are synchronized through a Yjs shared document over an authenticated WebSocket connection. Concurrent text and structural changes merge automatically, active collaborators and their current editing location are shown in the page header, and edits made during a temporary disconnect are merged after reconnection.

Attachment bytes continue to use the authenticated upload/download API. The server publishes the canonical attachment block into the Yjs room so collaborators receive it without allowing clients to forge file metadata. Yjs updates are persisted in MariaDB and periodically materialized into the normal page/block tables for search, render, export, and backup compatibility.

Archiving a shared page, permanently deleting a page subtree, and restoring the full workspace coordinate same-origin tabs before changing persistence. They stop when any affected page still has a browser-only, server-unconfirmed Yjs recovery record. Recovery records are keyed by both source tab and server-issued document epoch. Records from a replaced, unknown, or legacy generation are never merged into the current document and are never overwritten by a new generation from the same tab. The workspace home groups every local recovery by epoch, decodes its readable title and block data where possible, and retains the original encoded update as a fallback.

See [Page sharing and real-time collaboration](../../collaboration/2026-07-29/collaboration.md) for the access model, protocol, persistence, HTTPS deployment, and verification commands.

### Keyboard and block controls

| Action | Result |
| --- | --- |
| `Enter` | Insert a block below the current one |
| `Shift + Enter` | Add a line break inside the same block |
| `Backspace` on an empty block | Remove it, promote nested children in place, and move focus to the previous block; ambiguous network completion is retried with the same deletion receipt |
| `/` | Open the block type menu |
| `Ctrl/Cmd + B` | Apply bold formatting to selected text |
| `Ctrl/Cmd + I` | Apply italic formatting to selected text |
| `Ctrl/Cmd + Shift + M` | Wrap selected text as an inline LaTeX formula |
| Drag the six-dot handle | Reorder a block within its current hierarchy |

Useful slash commands include:

```text
/h1  /h2  /h3  /todo  /quote  /callout  /table  /database  /gantt  /board  /bookmark  /ai  /math  /code  /divider  /image  /file
```

Inline formatting supports bold, italic, strikethrough, code, formulas, links, text color, and left/center/right/justified block alignment. Drag-and-drop reordering supports nested content.

Table blocks include row, column, and header controls. Cells support arrow-key movement; `Enter` advances down the current column, and `Tab` from the final cell adds a row.

## Database and Kanban blocks

Type `/database` to create a database block. Each database has one required title property plus optional text, number, select, multi-select, checkbox, date, and URL properties.

Table, board, and list views operate over the same rows. Each view stores its own name, layout, visible properties, filters, sort order, and board grouping. The editor includes view tabs, Properties/Filter/Sort popovers, in-view search, a split New button, transparent column headers, and colored select pills.

Property and row changes are stored in `metadata.database`, while a searchable text summary is kept in `markdown`.

Kanban boards support direct title, group, and card editing. Cards can use an emoji and a default, pink, yellow, blue, light-green, purple, or peach pastel theme. Drag the six-dot card handle to reorder cards or move them between groups; arrow controls provide equivalent movement on touch devices and for keyboard users.

## Gantt timeline blocks

Type `/gantt` to create a project timeline that combines a sticky task table with a horizontally scrollable date grid. Each task stores a title, status, assignee, start and end dates, and progress percentage.

Use the week, month, or quarter scale; jump to today or move through adjacent date ranges; and optionally shade weekends. Drag a task bar to move the whole schedule, drag either edge to adjust its duration, or use the left and right arrow keys. Holding `Shift` while pressing an arrow key adjusts the end date instead of moving the task.

Gantt data is stored under `metadata.gantt`, while a bounded plain-text summary is kept in `markdown` so page search can match timeline titles, tasks, statuses, assignees, dates, and progress.

## LaTeX formulas

Type `/math` to create a centered display-formula block with a live KaTeX preview. Enter the source without surrounding delimiters, for example:

```text
\frac{-b \pm \sqrt{b^2-4ac}}{2a}
```

For inline formulas, select text and press the `∑` toolbar button or use `Ctrl/Cmd + Shift + M`; BrainVault wraps the selection in `\(...\)`. Markdown blocks also recognize `$...$` and display formulas delimited by `$$...$$`.

Formula rendering is sanitized and uses KaTeX with trusted commands disabled.

## AI conversation blocks

Type `/ai` to store a question and an AI answer as a two-sided chat transcript. The question appears as a right-aligned bubble, while the answer appears as a left-aligned bubble with its AI identity and response metadata.

The icon picker includes ChatGPT, Gemini, Claude, DeepSeek, and Grok. The provider icon, free-form model name, local answer date/time, question, and answer are stored under `metadata.aiChat`. A bounded text summary is also written to `markdown`, so search can match the provider, model, question, or answer. Read mode hides configuration controls while preserving the conversation presentation.

## Bookmark blocks

Type `/bookmark` to create a web bookmark collection. Paste an HTTP or HTTPS URL and BrainVault fetches the page metadata on the server.

The block supports two views:

- **List:** compact rows containing a favicon and title
- **Gallery:** responsive cards containing an OpenGraph thumbnail, title, description, favicon, and site name

Bookmarks can be refreshed or removed. Metadata is stored under `metadata.bookmark`, while titles, descriptions, and URLs are summarized into `markdown` for search.

When a public site blocks automated preview requests, times out, returns a non-HTML response, or is temporarily unreachable, BrainVault still adds a basic bookmark containing the original URL, hostname, and default favicon path. The editor reports the fallback and allows a later refresh.

Security details for server-side preview fetching are documented in [Security](../../security/2026-07-30/security.md#bookmark-preview-safety).

## YouTube video blocks

Type `/video` and paste a standard YouTube, `youtu.be`, Shorts, Live, or embed URL. BrainVault validates the video ID, preserves an optional start time, and renders a responsive privacy-enhanced `youtube-nocookie.com` player without requiring a YouTube API key.

The original URL remains in `markdown` so search, collaboration, version history, backup, and restore continue to use the normal block persistence path.

## Attachment blocks

Type `/file`, choose **Attachment**, and select a file. When the current block contains only the slash command, it is replaced in place; otherwise the attachment is inserted below it. The card shows the original filename, media type, size, and an authenticated download button.

Uploaded bytes are stored under `ATTACHMENT_UPLOAD_DIR`, which defaults to `uploads/`. The default maximum file size is 25 MB and can be changed with `MAX_ATTACHMENT_SIZE_MB`.

Attachment storage and deletion rules are documented in [Security](../../security/2026-07-30/security.md#attachment-safety).

## Complete backup and restore

Open **Settings → Data** to download a complete BrainVault backup or restore an archive exported by BrainVault.

The ZIP contains the account workspace graph: normal and archived pages, collections, nested blocks, block metadata, page/tag relationships, page sharing grants bound to collaborator account ID and username, supported profile preferences, every attachment as its original byte sequence, and custom page-cover bytes. Current v2 exports store custom covers as digest-bound `page-covers/` ZIP entries instead of inflating the JSON manifest; v1 backups with inline custom covers remain importable. Before export, BrainVault coordinates same-origin tabs and refuses to create an incomplete archive while an owned page still has an unsaved direct draft or an unconfirmed real-time recovery snapshot in browser storage.

Restore replaces the current account's workspace content. The login username, password hash, authenticator secret, passkeys, and other security credentials are not exported and remain unchanged. Every collaborator referenced by a current-format backup must exist with the same account ID and username on the destination server; otherwise restore fails before any workspace data is replaced. Username-only sharing records from the earlier format must match a current exact page-to-account grant. For older backups that omit sharing export entirely, grants already present on matching ordinary page IDs, including retained grants on archived pages, are preserved instead of being silently removed.

The historical Yjs update log is not included. Collaborative content must be fully materialized before export, and the restored pages receive a fresh collaboration generation while their exported sharing grants are recreated.

Validation, staging, digest checks, transaction behavior, and archive limits are documented in [Security](../../security/2026-07-30/security.md#backup-and-restore-safety).

## PDF export

Open a page and select **Export PDF** in the page toolbar. BrainVault prepares only the current page, removes editor-only controls, preserves backgrounds and colors, expands horizontally scrollable tables and boards, and opens the browser print dialog. Choose **Save as PDF** to create the file.

The print stylesheet uses A4 landscape pages so the default 900 px document layout stays unchanged where possible. Exceptionally wide tables, Kanban boards, database views, and Gantt timelines are scaled uniformly to prevent horizontal clipping.

## Languages

The browser interface supports:

- English (`en`)
- Japanese (`ja`)
- Korean (`ko`)
- French (`fr`)
- German (`de`)
- Spanish (`es`)
- Portuguese (`pt`)

On the first visit, BrainVault checks `navigator.languages`, selects the first supported browser language, and falls back to English when no match is available. After sign-in, open the user card at the top of the sidebar and choose **Preferences** to change the language.

The selection is saved to the account and to `localStorage` under `brainvault.language`. Translation implementation details are in [Development](../../development/2026-07-28/development.md#translations).
