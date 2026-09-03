import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  pageBatches: [] as Array<Array<Record<string, unknown>>>
}));

vi.mock("../src/lib/db.js", () => ({
  db: { query: database.query, queryOne: database.queryOne, execute: database.execute },
  transaction: async (fn: (client: unknown) => unknown) =>
    fn({ query: database.query, queryOne: database.queryOne, execute: database.execute })
}));

import { createApp } from "../src/app.js";
import { signAuthToken } from "../src/lib/auth.js";

const user = {
  id: "usr_page_list",
  username: "page-list",
  name: "Page List",
  password_hash: "unused",
  created_at: "2026-07-18T00:00:00.000Z",
  updated_at: "2026-07-18T00:00:00.000Z"
};
const token = signAuthToken({ sub: user.id, username: user.username, authVersion: 1 });

function page(id: string, createdAt: string, updatedAt = createdAt) {
  return {
    id,
    title: id,
    icon: null,
    cover_url: null,
    is_archived: 0,
    is_collection: 0,
    owner_id: user.id,
    parent_page_id: null,
    edit_version: 1,
    content_version: 1,
    created_at: createdAt,
    updated_at: updatedAt,
    cursor_created_at: createdAt,
    block_count: 0,
    child_count: 0
  };
}

beforeEach(() => {
  database.pageBatches = [];
  database.query.mockReset();
  database.queryOne.mockReset();
  database.execute.mockReset();
  database.queryOne.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM users WHERE id = ?")) return user;
    if (sql.includes("FROM pages WHERE id = ? AND owner_id = ?")) {
      return page(String(params[0]), "2026-07-18 00:00:00.000000");
    }
    return undefined;
  });
  database.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM pages p") && sql.includes("AS cursor_created_at")) return database.pageBatches.shift() ?? [];
    if (sql.includes("FROM users") && sql.includes("WHERE id IN")) return [user];
    if (sql.includes("FROM page_tags")) return [];
    return [];
  });
});

describe("Page-list pagination", () => {
  it("uses an immutable cursor so edits cannot move an unread page ahead of the scan", async () => {
    database.pageBatches.push([
      page("pag_c", "2026-07-18 12:00:00.000000"),
      page("pag_b", "2026-07-18 11:00:00.000000"),
      page("pag_a", "2026-07-18 10:00:00.000000")
    ]);

    const first = await request(createApp())
      .get("/api/pages?limit=2")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(first.body.pages.map((item: { id: string }) => item.id)).toEqual(["pag_c", "pag_b"]);
    expect(first.body.pages[0].owner.id).toBe(user.id);
    expect(first.body.pages[0].counts).toEqual({ blocks: 0, children: 0 });
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const cursorPayload = JSON.parse(
      Buffer.from(first.body.nextCursor, "base64url").toString("utf8")
    );
    expect(cursorPayload).toEqual({ createdAt: "2026-07-18 11:00:00.000000", id: "pag_b" });
    expect(cursorPayload).not.toHaveProperty("updatedAt");
    const firstListCall = database.query.mock.calls.find(([sql]) => String(sql).includes("AS cursor_created_at"));
    expect(firstListCall?.[0]).toContain("ORDER BY p.created_at DESC, p.id DESC");
    expect(firstListCall?.[0]).not.toContain("ORDER BY p.updated_at DESC, p.id DESC");
    expect(firstListCall?.[1]).toEqual([
      user.id,
      user.id,
      user.id,
      user.id,
      user.id,
      user.id,
      0,
      3
    ]);

    database.query.mockClear();
    // pag_a was edited after the first request. Its updated_at now sorts ahead
    // of the old cursor, but its immutable created_at remains behind the frontier.
    database.pageBatches.push([
      page("pag_a", "2026-07-18 10:00:00.000000", "2026-07-18 13:00:00.000000")
    ]);
    const second = await request(createApp())
      .get(`/api/pages?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(second.body.pages.map((item: { id: string }) => item.id)).toEqual(["pag_a"]);
    expect(second.body.nextCursor).toBeNull();
    const secondListCall = database.query.mock.calls.find(([sql]) => String(sql).includes("AS cursor_created_at"));
    expect(secondListCall?.[0]).toContain("p.created_at < ?");
    expect(secondListCall?.[0]).not.toContain("p.updated_at < ?");
    expect(secondListCall?.[1]).toEqual([
      user.id,
      user.id,
      user.id,
      user.id,
      user.id,
      user.id,
      0,
      "2026-07-18 11:00:00.000000",
      "2026-07-18 11:00:00.000000",
      "pag_b",
      3
    ]);
  });

  it("keeps compact large-workspace batches bounded without changing the default response", async () => {
    database.pageBatches.push([
      page("pag_compact", "2026-07-18 12:00:00.000000")
    ]);

    const response = await request(createApp())
      .get("/api/pages?limit=500&compact=true")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body.pages).toHaveLength(1);
    expect(response.body.pages[0].id).toBe("pag_compact");
    expect(response.body.pages[0]).not.toHaveProperty("owner");
    expect(response.body.pages[0]).not.toHaveProperty("counts");

    const listCall = database.query.mock.calls.find(([sql]) => String(sql).includes("AS cursor_created_at"));
    expect(listCall?.[0]).not.toContain("AS block_count");
    expect(listCall?.[0]).not.toContain("AS child_count");
    expect(listCall?.[1]).toEqual([user.id, user.id, user.id, 0, 501]);
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes("FROM users") && String(sql).includes("WHERE id IN"))).toBe(false);
    expect(database.query.mock.calls.filter(([sql]) => String(sql).includes("SELECT pcm.page_id, pcm.collection_id"))).toHaveLength(1);
    expect(database.query.mock.calls.filter(([sql]) => String(sql).includes("effective_shares"))).toHaveLength(1);
    expect(database.query.mock.calls.filter(([sql]) => String(sql).includes("FROM page_tags pt"))).toHaveLength(1);
  });

  it("lets the internal navigation scan omit tag enrichment without changing compact semantics", async () => {
    database.pageBatches.push([
      page("pag_navigation", "2026-07-18 12:00:00.000000")
    ]);

    const response = await request(createApp())
      .get("/api/pages?limit=500&compact=true&navigation=true")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body.pages).toHaveLength(1);
    expect(response.body.pages[0].id).toBe("pag_navigation");
    expect(response.body.pages[0].tags).toEqual([]);
    expect(response.body.pages[0]).not.toHaveProperty("owner");
    expect(response.body.pages[0]).not.toHaveProperty("counts");
    expect(database.query.mock.calls.filter(([sql]) => String(sql).includes("FROM page_tags pt"))).toHaveLength(0);
  });

  it("rejects a malformed cursor before running the page query", async () => {
    const response = await request(createApp())
      .get("/api/pages?cursor=not-a-valid-cursor")
      .set("Authorization", `Bearer ${token}`)
      .expect(400);

    expect(response.body.error.code).toBe("INVALID_PAGE_CURSOR");
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes("AS cursor_created_at"))).toBe(false);
  });
});
