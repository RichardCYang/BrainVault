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
  db: { query: database.query, queryOne: database.queryOne, execute: database.execute },
  transaction: async (fn: (client: unknown) => unknown) =>
    fn({ query: database.query, queryOne: database.queryOne, execute: database.execute })
}));

import { createApp } from "../src/app.js";
import { signAuthToken } from "../src/lib/auth.js";

const user = {
  id: "usr_hierarchy",
  username: "hierarchy",
  name: "Hierarchy",
  password_hash: "unused",
  created_at: "2026-07-17T00:00:00.000Z",
  updated_at: "2026-07-17T00:00:00.000Z"
};
const token = signAuthToken({ sub: user.id, username: user.username });

function page(id: string, parentPageId: string | null) {
  return {
    id,
    title: id,
    icon: null,
    cover_url: null,
    is_archived: 0,
    is_collection: 0,
    owner_id: user.id,
    parent_page_id: parentPageId,
    edit_version: 1,
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z"
  };
}

function block(id: string, parentBlockId: string | null) {
  return {
    id,
    page_id: "pag_a",
    parent_block_id: parentBlockId,
    type: "MARKDOWN",
    markdown: id,
    html_cache: `<p>${id}</p>`,
    checked: 0,
    sort_order: 0,
    metadata: null,
    edit_version: 1,
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z"
  };
}

beforeEach(() => {
  database.pages = new Map([
    ["pag_a", page("pag_a", null)],
    ["pag_b", page("pag_b", "pag_a")]
  ]);
  database.blocks = new Map([
    ["blk_a", block("blk_a", null)],
    ["blk_b", block("blk_b", "blk_a")]
  ]);
  database.query.mockReset();
  database.queryOne.mockReset();
  database.execute.mockReset();

  database.queryOne.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM users WHERE id = ?")) return user;
    if (sql.includes("FROM pages WHERE id = ? AND owner_id = ?")) {
      return database.pages.get(String(params[0]));
    }
    if (sql.includes("INNER JOIN pages p") && sql.includes("WHERE b.id = ?")) {
      return database.blocks.get(String(params[0]));
    }
    if (sql.includes("SELECT * FROM blocks WHERE id = ?")) {
      return database.blocks.get(String(params[0]));
    }
    return undefined;
  });

  database.query.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("SELECT id, parent_page_id, edit_version") && sql.includes("FROM pages")) {
      return [...database.pages.values()].map((item) => ({
        id: item.id,
        parent_page_id: item.parent_page_id,
        edit_version: item.edit_version
      }));
    }
    if (sql.includes("SELECT * FROM blocks WHERE page_id = ?") && params[0] === "pag_a") {
      return [...database.blocks.values()];
    }
    return [];
  });

  database.execute.mockResolvedValue({ affectedRows: 1 });
});

describe("Hierarchy and archive integrity", () => {
  it("rejects a page move that would close a concurrent hierarchy cycle", async () => {
    const response = await request(createApp())
      .patch("/api/pages/pag_a")
      .set("Authorization", `Bearer ${token}`)
      .send({ parentPageId: "pag_b", expectedVersion: 1 })
      .expect(400);

    expect(response.body.error.code).toBe("INVALID_PARENT_PAGE");
    expect(database.execute).not.toHaveBeenCalled();
  });

  it("rejects a block move that would close a concurrent hierarchy cycle", async () => {
    const response = await request(createApp())
      .patch("/api/blocks/blk_a")
      .set("Authorization", `Bearer ${token}`)
      .send({ parentBlockId: "blk_b", expectedVersion: 1 })
      .expect(400);

    expect(response.body.error.code).toBe("INVALID_PARENT_BLOCK");
    expect(database.execute).not.toHaveBeenCalled();
  });

  it("requires a version precondition on the legacy archive endpoint", async () => {
    const response = await request(createApp())
      .delete("/api/pages/pag_a")
      .set("Authorization", `Bearer ${token}`)
      .expect(400);

    expect(response.body.error.code).toBe("PAGE_EDIT_VERSION_REQUIRED");
    expect(database.execute).not.toHaveBeenCalled();
  });
});
