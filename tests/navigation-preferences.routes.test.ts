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
  it("loads the authenticated user's collapsed page ids from the database", async () => {
    database.query.mockResolvedValue([{ page_id: "pg_a" }, { page_id: "pg_b" }]);

    const response = await request(createApp())
      .get("/api/auth/navigation-preferences")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({ collapsedPageIds: ["pg_a", "pg_b"] });
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM user_navigation_collapsed_pages"),
      [user.id]
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
});
