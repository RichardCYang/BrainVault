import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { diffWorkspaceManifests } from "../src/lib/workspace-snapshot-diff.ts";

const ts = "2026-08-15 12:00:00.000000";
const hash = (value) => createHash("sha256").update(value).digest("hex");

function page(overrides = {}) {
  return {
    id: "page_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    title: "Snapshot page",
    icon: "🧠",
    cover_url: null,
    cover_position_x: 50,
    cover_position_y: 50,
    is_archived: 0,
    is_collection: 0,
    parent_page_id: null,
    edit_version: 7,
    content_version: 9,
    created_at: ts,
    updated_at: ts,
    ...overrides
  };
}

function block(overrides = {}) {
  return {
    id: "block_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    page_id: "page_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    parent_block_id: null,
    type: "ATTACHMENT",
    markdown: "attachment",
    html_cache: "<p>attachment</p>",
    checked: 0,
    sort_order: 1024,
    metadata: '{"name":"file.bin"}',
    edit_version: 4,
    created_at: ts,
    updated_at: ts,
    ...overrides
  };
}

function manifest(overrides = {}) {
  const bytes = Buffer.from("binary attachment bytes");
  const base = {
    format: "brainvault-backup",
    version: 4,
    exportedAt: "2026-08-15T12:00:00.000Z",
    source: { userId: "user_cccccccccccccccccccccccccccccccc", username: "snapshot-user" },
    account: {
      name: "Snapshot User",
      avatar_data: null,
      preferred_language: "en",
      default_collection_icon: "📁",
      theme: "light"
    },
    data: {
      pages: [page()],
      blocks: [block()],
      tags: [{ id: "tag_dddddddddddddddddddddddddddddddd", name: "work", created_at: ts }],
      pageTags: [{ page_id: "page_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tag_id: "tag_dddddddddddddddddddddddddddddddd" }],
      pageShares: [{
        page_id: "page_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        shared_user_id: "user_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        shared_username: "collaborator",
        permission: "EDIT",
        created_at: ts
      }],
      pageVersions: [{
        page_id: "page_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        revision: 1,
        page_edit_version: 7,
        page_content_version: 9,
        actors: "[]",
        source: "user",
        change_count: 1,
        change_summary: "{}",
        changes: "[]",
        created_at: ts
      }],
      navigationCollapsedPageIds: ["page_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      navigationPageOrder: [{ page_id: "page_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sort_order: 0 }]
    },
    attachments: [{
      blockId: "block_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      path: "attachments/block_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      size: String(bytes.length),
      sha256: hash(bytes),
      crc32: 1234
    }],
    retainedAttachments: [],
    pageCovers: [],
    customIcons: [],
    customIconLibraryRemovals: []
  };
  return { ...base, ...overrides, data: { ...base.data, ...(overrides.data ?? {}) } };
}

test("identical canonical manifests compare as identical even when export timestamps differ", () => {
  const before = manifest();
  const current = structuredClone(before);
  current.exportedAt = "2026-08-15T12:30:00.000Z";
  const result = diffWorkspaceManifests(before, current);
  assert.equal(result.identical, true);
  assert.deepEqual(result.summary.pages, { added: 0, removed: 0, modified: 0 });
  assert.deepEqual(result.summary.blocks, { added: 0, removed: 0, modified: 0 });
  assert.equal(result.summary.workspace, 0);
});

test("page, history, block body, attachment bytes, and account-level differences are all detected", () => {
  const before = manifest();
  const current = structuredClone(before);
  current.account.theme = "dark";
  current.data.pages[0].title = "Current page";
  current.data.pages[0].content_version = 10;
  current.data.pageVersions[0].changes = '[{"field":"title"}]';
  current.data.blocks[0].markdown = `${"A".repeat(7000)}CURRENT${"B".repeat(7000)}`;
  current.data.blocks[0].html_cache = `<p>${"rendered".repeat(1000)}</p>`;
  current.attachments[0].sha256 = hash("different attachment bytes");
  current.attachments[0].crc32 = 4321;

  const result = diffWorkspaceManifests(before, current);
  assert.equal(result.identical, false);
  assert.deepEqual(result.summary.pages, { added: 0, removed: 0, modified: 1 });
  assert.deepEqual(result.summary.blocks, { added: 0, removed: 0, modified: 1 });
  assert.equal(result.summary.workspace, 1);
  assert.ok(result.workspace.some((field) => field.field === "theme"));

  const pageDiff = result.pages[0];
  assert.ok(pageDiff.fields.some((field) => field.field === "title"));
  assert.ok(pageDiff.fields.some((field) => field.field === "contentVersion"));
  const history = pageDiff.fields.find((field) => field.field === "historyData");
  assert.equal(typeof history.snapshot, "object");
  assert.equal(history.snapshot.sha256.length, 64);

  const blockDiff = pageDiff.blocks[0];
  const markdown = blockDiff.fields.find((field) => field.field === "markdown");
  assert.equal(typeof markdown.snapshot, "object");
  assert.equal(typeof markdown.current, "object");
  assert.ok(markdown.current.excerpt.length <= 180);
  assert.equal(markdown.current.sha256.length, 64);
  assert.ok(blockDiff.fields.some((field) => field.field === "htmlCache"));
  assert.ok(blockDiff.fields.some((field) => field.field === "attachmentFile"));
});

test("added and removed pages and blocks are counted without losing summary totals", () => {
  const before = manifest();
  const current = manifest({
    data: {
      pages: [page({ id: "page_ffffffffffffffffffffffffffffffff", title: "New page" })],
      blocks: [block({
        id: "block_11111111111111111111111111111111",
        page_id: "page_ffffffffffffffffffffffffffffffff",
        type: "MARKDOWN"
      })],
      tags: [],
      pageTags: [],
      pageShares: [],
      pageVersions: [],
      navigationCollapsedPageIds: [],
      navigationPageOrder: []
    },
    attachments: []
  });

  const result = diffWorkspaceManifests(before, current);
  assert.deepEqual(result.summary.pages, { added: 1, removed: 1, modified: 0 });
  assert.deepEqual(result.summary.blocks, { added: 1, removed: 1, modified: 0 });
  assert.equal(result.pages.length, 2);
});

test("detail limits truncate expansion only while preserving complete counts", () => {
  const before = manifest({
    data: {
      pages: [], blocks: [], tags: [], pageTags: [], pageShares: [], pageVersions: [],
      navigationCollapsedPageIds: [], navigationPageOrder: []
    },
    attachments: []
  });
  const currentPages = Array.from({ length: 205 }, (_, index) => page({
    id: `page_${index.toString(16).padStart(32, "0")}`,
    title: `Page ${index}`
  }));
  const current = manifest({
    data: {
      pages: currentPages, blocks: [], tags: [], pageTags: [], pageShares: [], pageVersions: [],
      navigationCollapsedPageIds: [], navigationPageOrder: []
    },
    attachments: []
  });

  const result = diffWorkspaceManifests(before, current);
  assert.equal(result.summary.pages.added, 205);
  assert.equal(result.pages.length, 200);
  assert.equal(result.detailsTruncated, true);
  assert.deepEqual(result.limits, { pageDetails: 200, blockDetails: 500 });
});
