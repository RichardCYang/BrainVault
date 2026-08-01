import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn()
}));

vi.mock("../src/lib/db.js", () => ({
  db: database,
  transaction: async (fn: (client: unknown) => unknown) => fn(database)
}));

import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { signAuthToken } from "../src/lib/auth.js";

const user = {
  id: "usr_bookmark_limit",
  username: "bookmark-limit",
  name: "Bookmark Limit",
  password_hash: "unused",
  auth_version: 1,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z"
};
const token = signAuthToken({ sub: user.id, username: user.username, authVersion: 1 });

beforeEach(() => {
  database.queryOne.mockReset().mockResolvedValue(user);
  database.query.mockReset().mockResolvedValue([]);
  database.execute.mockReset().mockResolvedValue({ affectedRows: 1 });
});

describe("Bookmark preview request limits", () => {
  it("applies a dedicated authenticated-user limit", async () => {
    const app = createApp();
    for (let requestIndex = 0; requestIndex < env.BOOKMARK_PREVIEW_MAX; requestIndex += 1) {
      const response = await request(app)
        .post("/api/bookmarks/preview")
        .set("Authorization", `Bearer ${token}`)
        .send({ url: "http://localhost:4000/" })
        .expect(400);
      expect(response.body.error.code).toBe("BOOKMARK_URL_BLOCKED");
    }

    const limited = await request(app)
      .post("/api/bookmarks/preview")
      .set("Authorization", `Bearer ${token}`)
      .send({ url: "http://localhost:4000/" })
      .expect(429);
    expect(limited.body.error.code).toBe("BOOKMARK_PREVIEW_RATE_LIMITED");
  });
});
