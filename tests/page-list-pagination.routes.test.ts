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
const token = signAuthToken({ sub: user.id, username: user.username });

function page(id: string, updatedAt: string) {
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
    created_at: updatedAt,
    updated_at: updatedAt,
    cursor_updated_at: updatedAt,
    block_count: 0,
    child_count: 0
  };
}

beforeEach(() => {
  database.pageBatches = [];
  database.query.mockReset();
  database.queryOne.mockReset();
  database.execute.mockReset();
  database.queryOne.mockImplementation(async (sql: string) =>
    sql.includes("FROM users WHERE id = ?") ? user : undefined
  );
  database.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT p.*") && sql.includes("FROM pages p")) return database.pageBatches.shift() ?? [];
    if (sql.includes("FROM page_tags")) return [];
    return [];
  });
});

describe("Page-list pagination", () => {
  it("returns an opaque cursor and resumes after the last emitted page", async () => {
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
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const firstListCall = database.query.mock.calls.find(([sql]) => String(sql).includes("SELECT p.*"));
    expect(firstListCall?.[0]).toContain("ORDER BY p.updated_at DESC, p.id DESC");
    expect(firstListCall?.[1]).toEqual([user.id, 0, 3]);

    database.query.mockClear();
    database.pageBatches.push([page("pag_a", "2026-07-18 10:00:00.000000")]);
    const second = await request(createApp())
      .get(`/api/pages?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(second.body.pages.map((item: { id: string }) => item.id)).toEqual(["pag_a"]);
    expect(second.body.nextCursor).toBeNull();
    const secondListCall = database.query.mock.calls.find(([sql]) => String(sql).includes("SELECT p.*"));
    expect(secondListCall?.[0]).toContain("p.updated_at < ?");
    expect(secondListCall?.[1]).toEqual([
      user.id,
      0,
      "2026-07-18 11:00:00.000000",
      "2026-07-18 11:00:00.000000",
      "pag_b",
      3
    ]);
  });

  it("rejects a malformed cursor before running the page query", async () => {
    const response = await request(createApp())
      .get("/api/pages?cursor=not-a-valid-cursor")
      .set("Authorization", `Bearer ${token}`)
      .expect(400);

    expect(response.body.error.code).toBe("INVALID_PAGE_CURSOR");
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes("SELECT p.*"))).toBe(false);
  });
});
