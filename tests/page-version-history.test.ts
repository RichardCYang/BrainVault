import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  diffPageVersionBlocks,
  diffPageVersionPage
} from "../src/lib/page-version-history.js";
import type { BlockRow, PageRow } from "../src/types/domain.js";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const pageRoutes = readFileSync(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8");
const blockRoutes = readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8");
const collaborationRoutes = readFileSync(new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/027_page_version_history.sql", import.meta.url), "utf8");

function page(overrides: Partial<PageRow> = {}): PageRow {
  return {
    id: "pag_history",
    title: "Before",
    icon: null,
    cover_url: null,
    is_archived: 0,
    is_collection: 0,
    owner_id: "usr_owner",
    parent_page_id: null,
    edit_version: 1,
    content_version: 1,
    created_at: "2026-07-31 00:00:00.000",
    updated_at: "2026-07-31 00:00:00.000",
    ...overrides
  };
}

function block(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: "blk_history",
    page_id: "pag_history",
    parent_block_id: null,
    type: "MARKDOWN",
    markdown: "Before",
    html_cache: "<p>Before</p>",
    checked: 0,
    sort_order: 0,
    metadata: null,
    edit_version: 1,
    created_at: "2026-07-31 00:00:00.000",
    updated_at: "2026-07-31 00:00:00.000",
    ...overrides
  };
}

describe("Page version history", () => {
  it("adds the page-menu entry, list-first dialog, detail panel, and Korean copy", () => {
    expect(index).toMatch(/id="page-actions-menu"[\s\S]*id="page-version-history-button"/);
    expect(index).toContain('id="page-version-history-dialog"');
    expect(index).toContain('id="page-version-history-list"');
    expect(index).toContain('id="page-version-history-detail"');
    expect(client).toContain("function openPageVersionHistory");
    expect(client).toContain("function loadPageVersionHistory");
    expect(client).toContain("function loadPageVersionDetail");
    expect(client).toContain("createPageVersionFieldChange");
    expect(styles).toContain(".page-version-history-dialog");
    expect(styles).toContain(".page-version-before-after");
    expect(i18n).toContain('menu: "페이지 버전 정보"');
    expect(i18n).toContain('title: "페이지 버전 이력"');
  });

  it("stores immutable actor, revision, summary, and before/after JSON data", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS page_versions");
    expect(migration).toContain("revision BIGINT UNSIGNED NOT NULL");
    expect(migration).toContain("actors JSON NOT NULL");
    expect(migration).toContain("change_summary JSON NOT NULL");
    expect(migration).toContain("changes JSON NOT NULL");
    expect(migration).toContain("uq_page_versions_revision UNIQUE (page_id, revision)");
    expect(pageRoutes).toContain('"/:pageId/versions"');
    expect(pageRoutes).toContain('"/:pageId/versions/:versionId"');
    expect(blockRoutes).toContain('source: "BLOCK_UPDATE"');
    expect(blockRoutes).toContain('source: "BLOCK_DELETE"');
    expect(collaborationRoutes).toContain('source: "COLLABORATION"');
    expect(collaborationRoutes).toContain("loadPageVersionActors");
  });

  it("detects exact page field and tag changes", () => {
    const changes = diffPageVersionPage(
      page(),
      page({ title: "After", icon: "🧠", edit_version: 2 }),
      ["old"],
      ["new"]
    );

    expect(changes).toEqual([
      {
        kind: "page-updated",
        fields: [
          { field: "title", before: "Before", after: "After" },
          { field: "icon", before: null, after: "🧠" },
          { field: "tags", before: ["old"], after: ["new"] }
        ]
      }
    ]);
  });

  it("detects block creation, content updates, moves, and deletion", () => {
    const changes = diffPageVersionBlocks(
      [
        block(),
        block({ id: "blk_deleted", markdown: "Gone" })
      ],
      [
        block({ markdown: "After", parent_block_id: "blk_parent", sort_order: 2, edit_version: 2 }),
        block({ id: "blk_added", markdown: "New" })
      ]
    );

    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "block-deleted", block: expect.objectContaining({ id: "blk_deleted" }) }),
      expect.objectContaining({ kind: "block-created", block: expect.objectContaining({ id: "blk_added" }) }),
      expect.objectContaining({
        kind: "block-updated",
        blockId: "blk_history",
        fields: expect.arrayContaining([
          { field: "parentBlockId", before: null, after: "blk_parent" },
          { field: "markdown", before: "Before", after: "After" },
          { field: "sortOrder", before: 0, after: 2 }
        ])
      })
    ]));
  });
});
