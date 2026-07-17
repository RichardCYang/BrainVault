import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  pages: new Map<string, Record<string, unknown>>(),
  blocks: new Map<string, Record<string, unknown>>(),
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn()
}));

vi.mock("../src/lib/db.js", () => ({
  db: {
    query: database.query,
    queryOne: database.queryOne,
    execute: database.execute
  },
  transaction: async (fn: (client: unknown) => unknown) =>
    fn({ query: database.query, queryOne: database.queryOne, execute: database.execute })
}));

import { createApp } from "../src/app.js";
import { signAuthToken } from "../src/lib/auth.js";

const user = {
  id: "usr_page_delete",
  username: "page-delete",
  name: "Page Delete",
  password_hash: "unused",
  created_at: "2026-07-16T00:00:00.000Z",
  updated_at: "2026-07-16T00:00:00.000Z"
};
const token = signAuthToken({ sub: user.id, username: user.username });

function makePage(id: string, parentPageId: string | null, isCollection = false) {
  return {
    id,
    title: id,
    icon: isCollection ? "📁" : "📄",
    cover_url: null,
    is_archived: 0,
    is_collection: isCollection ? 1 : 0,
    owner_id: user.id,
    parent_page_id: parentPageId,
    edit_version: 1,
    content_version: 1,
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z"
  };
}

function makeBlock(id: string, pageId: string, type = "MARKDOWN") {
  return {
    id,
    page_id: pageId,
    parent_block_id: null,
    type,
    edit_version: 1
  };
}

async function getDeletionSnapshot(pageId = "pag_collection") {
  const response = await request(createApp())
    .get(`/api/pages/${pageId}/deletion-snapshot`)
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  expect(response.body.snapshot).toMatch(/^[a-f0-9]{64}$/);
  expect(response.body.pageIds).toEqual(["pag_child", "pag_collection", "pag_grandchild"]);
  expect(response.body.pages).toEqual([
    { id: "pag_child", version: 1, contentVersion: 1 },
    { id: "pag_collection", version: 1, contentVersion: 1 },
    { id: "pag_grandchild", version: 1, contentVersion: 1 }
  ]);
  return String(response.body.snapshot);
}

beforeEach(() => {
  database.pages = new Map([
    ["pag_collection", makePage("pag_collection", null, true)],
    ["pag_child", makePage("pag_child", "pag_collection")],
    ["pag_grandchild", makePage("pag_grandchild", "pag_child")]
  ]);
  database.blocks = new Map([
    ["blk_root", makeBlock("blk_root", "pag_collection")],
    ["blk_child_attachment", makeBlock("blk_child_attachment", "pag_child", "ATTACHMENT")],
    ["blk_grandchild", makeBlock("blk_grandchild", "pag_grandchild")]
  ]);
  database.query.mockReset();
  database.queryOne.mockReset();
  database.execute.mockReset();

  database.queryOne.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM users WHERE id = ?")) return user;
    if (sql.includes("FROM pages WHERE id = ? AND owner_id = ?")) {
      return database.pages.get(String(params[0]));
    }
    return undefined;
  });

  database.query.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("SELECT id, parent_page_id, edit_version") && sql.includes("WHERE owner_id = ?")) {
      return [...database.pages.values()]
        .filter((page) => page.owner_id === params[0])
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
        .map((page) => ({
          id: page.id,
          parent_page_id: page.parent_page_id,
          edit_version: page.edit_version,
          content_version: page.content_version
        }));
    }
    if (sql.includes("SELECT id, page_id, type, edit_version") && sql.includes("WHERE page_id = ?")) {
      return [...database.blocks.values()]
        .filter((block) => block.page_id === params[0])
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
        .map((block) => ({ id: block.id, page_id: block.page_id, type: block.type, edit_version: block.edit_version }));
    }
    return [];
  });

  database.execute.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("DELETE FROM pages WHERE id = ? AND owner_id = ?")) {
      const pageId = String(params[0]);
      database.pages.delete(pageId);
      for (const [blockId, block] of database.blocks) {
        if (block.page_id === pageId) database.blocks.delete(blockId);
      }
    }
    return { affectedRows: 1 };
  });
});

describe("Permanent page deletion", () => {
  it("deletes a collection subtree from deepest page to root after validating every block version", async () => {
    const snapshot = await getDeletionSnapshot();

    await request(createApp())
      .delete("/api/pages/pag_collection?permanent=true")
      .set("Authorization", `Bearer ${token}`)
      .send({ expectedSnapshot: snapshot })
      .expect(204);

    const deletedPageIds = database.execute.mock.calls
      .filter(([sql]) => String(sql).includes("DELETE FROM pages WHERE id = ? AND owner_id = ?"))
      .map(([, params]) => String((params as readonly unknown[])[0]));

    expect(deletedPageIds).toEqual(["pag_grandchild", "pag_child", "pag_collection"]);
    expect(database.pages.size).toBe(0);
    expect(database.blocks.size).toBe(0);
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM blocks"),
      ["pag_child"]
    );
  });

  it("rejects deletion when any page in the subtree changed after the snapshot", async () => {
    const snapshot = await getDeletionSnapshot();
    database.pages.get("pag_child")!.edit_version = 2;

    const response = await request(createApp())
      .delete("/api/pages/pag_collection?permanent=true")
      .set("Authorization", `Bearer ${token}`)
      .send({ expectedSnapshot: snapshot })
      .expect(409);

    expect(response.body.error.code).toBe("PAGE_EDIT_CONFLICT");
    expect(database.pages.size).toBe(3);
  });


  it("rejects deletion when only a page content generation changed after the snapshot", async () => {
    const snapshot = await getDeletionSnapshot();
    database.pages.get("pag_child")!.content_version = 2;

    const response = await request(createApp())
      .delete("/api/pages/pag_collection?permanent=true")
      .set("Authorization", `Bearer ${token}`)
      .send({ expectedSnapshot: snapshot })
      .expect(409);

    expect(response.body.error.code).toBe("PAGE_EDIT_CONFLICT");
    expect(database.pages.size).toBe(3);
  });

  it("rejects deletion when a newer block edit exists even though page versions are unchanged", async () => {
    const snapshot = await getDeletionSnapshot();
    database.blocks.get("blk_grandchild")!.edit_version = 2;

    const response = await request(createApp())
      .delete("/api/pages/pag_collection?permanent=true")
      .set("Authorization", `Bearer ${token}`)
      .send({ expectedSnapshot: snapshot })
      .expect(409);

    expect(response.body.error.code).toBe("PAGE_EDIT_CONFLICT");
    expect(database.pages.size).toBe(3);
    expect(database.blocks.size).toBe(3);
    expect(database.execute).not.toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM pages"),
      expect.anything()
    );
  });

  it("requires a fresh deletion snapshot for permanent deletion", async () => {
    const response = await request(createApp())
      .delete("/api/pages/pag_collection?permanent=true")
      .set("Authorization", `Bearer ${token}`)
      .expect(400);

    expect(response.body.error.code).toBe("PAGE_DELETE_SNAPSHOT_REQUIRED");
    expect(database.pages.size).toBe(3);
  });
});
