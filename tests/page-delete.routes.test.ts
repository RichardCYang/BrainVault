import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  pages: new Map<string, Record<string, unknown>>(),
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
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z"
  };
}

beforeEach(() => {
  database.pages = new Map([
    ["pag_collection", makePage("pag_collection", null, true)],
    ["pag_child", makePage("pag_child", "pag_collection")],
    ["pag_grandchild", makePage("pag_grandchild", "pag_child")]
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
    if (sql.includes("SELECT id FROM pages WHERE parent_page_id = ?")) {
      return [...database.pages.values()]
        .filter((page) => page.parent_page_id === params[0] && page.owner_id === params[1])
        .map((page) => ({ id: page.id }));
    }
    if (sql.includes("SELECT id FROM blocks WHERE page_id = ? AND type = 'ATTACHMENT'")) {
      return [{ id: `att_${String(params[0])}` }];
    }
    return [];
  });

  database.execute.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("DELETE FROM pages WHERE id = ? AND owner_id = ?")) {
      database.pages.delete(String(params[0]));
    }
    return { affectedRows: 1 };
  });
});

describe("Permanent page deletion", () => {
  it("deletes a collection subtree from deepest page to root", async () => {
    await request(createApp())
      .delete("/api/pages/pag_collection?permanent=true")
      .set("Authorization", `Bearer ${token}`)
      .expect(204);

    const deletedPageIds = database.execute.mock.calls
      .filter(([sql]) => String(sql).includes("DELETE FROM pages WHERE id = ? AND owner_id = ?"))
      .map(([, params]) => String((params as readonly unknown[])[0]));

    expect(deletedPageIds).toEqual(["pag_grandchild", "pag_child", "pag_collection"]);
    expect(database.pages.size).toBe(0);
    expect(database.query).toHaveBeenCalledWith(
      "SELECT id FROM blocks WHERE page_id = ? AND type = 'ATTACHMENT'",
      ["pag_grandchild"]
    );
  });
});
