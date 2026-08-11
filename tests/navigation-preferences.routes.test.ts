import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn()
}));

vi.mock("../src/lib/db.js", () => ({
  db: database,
  transaction: async (fn: (client: unknown) => unknown) => fn(database)
}));

import { createApp } from "../src/app.js";
import { signAuthToken } from "../src/lib/auth.js";

const user = {
  id: "usr_navigation_preferences",
  username: "navigation-user",
  name: "Navigation User",
  avatar_data: null,
  preferred_language: null,
  default_collection_icon: null,
  theme: "light",
  password_hash: "unused",
  auth_version: 1,
  created_at: "2026-08-10T00:00:00.000Z",
  updated_at: "2026-08-10T00:00:00.000Z"
};

const token = signAuthToken({ sub: user.id, username: user.username, authVersion: user.auth_version });

beforeEach(() => {
  database.query.mockReset();
  database.queryOne.mockReset();
  database.execute.mockReset();

  database.query.mockResolvedValue([]);
  database.queryOne.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM users WHERE id = ?")) return { ...user };
    if (sql.includes("FROM pages p") && params[1] === "pg_visible") return { id: "pg_visible" };
    return undefined;
  });
  database.execute.mockResolvedValue({ affectedRows: 1 });
});

describe("Navigation collapse preferences", () => {
  it("loads the authenticated user's collapsed page ids and explicit page order", async () => {
    database.query
      .mockResolvedValueOnce([{ page_id: "pg_a" }, { page_id: "pg_b" }])
      .mockResolvedValueOnce([{ page_id: "pg_b", sort_order: 0 }, { page_id: "pg_a", sort_order: 1 }]);

    const response = await request(createApp())
      .get("/api/auth/navigation-preferences")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      collapsedPageIds: ["pg_a", "pg_b"],
      navigationPageOrder: [
        { pageId: "pg_b", sortOrder: 0 },
        { pageId: "pg_a", sortOrder: 1 }
      ]
    });
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM user_navigation_collapsed_pages"),
      [user.id]
    );
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM user_navigation_page_order no"),
      [user.id, user.id, user.id]
    );
  });

  it("persists collapse and expand intents for an accessible page", async () => {
    await request(createApp())
      .patch("/api/auth/navigation-preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ pageId: "pg_visible", collapsed: true })
      .expect(200, { pageId: "pg_visible", collapsed: true });

    expect(database.execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT IGNORE INTO user_navigation_collapsed_pages"),
      [user.id, "pg_visible"]
    );

    database.execute.mockClear();
    await request(createApp())
      .patch("/api/auth/navigation-preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ pageId: "pg_visible", collapsed: false })
      .expect(200, { pageId: "pg_visible", collapsed: false });

    expect(database.execute).toHaveBeenCalledWith(
      "DELETE FROM user_navigation_collapsed_pages WHERE user_id = ? AND page_id = ?",
      [user.id, "pg_visible"]
    );
  });

  it("does not let a user persist state for a page they cannot access", async () => {
    await request(createApp())
      .patch("/api/auth/navigation-preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ pageId: "pg_hidden", collapsed: true })
      .expect(404);

    expect(database.execute).not.toHaveBeenCalled();
  });

  it("stores an authenticated page order without mutating page content rows", async () => {
    database.query.mockResolvedValue([{ id: "pg_first" }, { id: "pg_second" }]);

    await request(createApp())
      .patch("/api/auth/navigation-order")
      .set("Authorization", `Bearer ${token}`)
      .send({ pageIds: ["pg_second", "pg_first"] })
      .expect(200, { pageIds: ["pg_second", "pg_first"] });

    expect(database.execute).toHaveBeenCalledTimes(1);
    expect(database.execute).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO user_navigation_page_order[\s\S]*ON DUPLICATE KEY UPDATE/),
      [user.id, "pg_second", 0, user.id, "pg_first", 1]
    );
    const sql = String(database.execute.mock.calls[0]?.[0] ?? "");
    expect(sql).not.toMatch(/UPDATE\s+pages|UPDATE\s+blocks/i);
  });

  it("rejects duplicate or inaccessible page ids before persisting order", async () => {
    await request(createApp())
      .patch("/api/auth/navigation-order")
      .set("Authorization", `Bearer ${token}`)
      .send({ pageIds: ["pg_first", "pg_first"] })
      .expect(400);
    expect(database.execute).not.toHaveBeenCalled();

    database.query.mockResolvedValue([{ id: "pg_first" }]);
    await request(createApp())
      .patch("/api/auth/navigation-order")
      .set("Authorization", `Bearer ${token}`)
      .send({ pageIds: ["pg_first", "pg_hidden"] })
      .expect(404);
    expect(database.execute).not.toHaveBeenCalled();
  });
});
