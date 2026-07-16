import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  queryOne: vi.fn(),
  execute: vi.fn()
}));

vi.mock("../src/lib/db.js", () => ({
  db: {
    query: vi.fn(async () => []),
    queryOne: database.queryOne,
    execute: database.execute
  },
  transaction: async (fn: (client: unknown) => unknown) => fn({ queryOne: database.queryOne, execute: database.execute })
}));

import { createApp } from "../src/app.js";
import { hashPassword, signAuthToken, verifyPassword } from "../src/lib/auth.js";

let user: Record<string, unknown>;
let token: string;

beforeEach(async () => {
  user = {
    id: "usr_account_settings",
    username: "settings-user",
    name: "Settings User",
    avatar_data: null,
    preferred_language: null,
    password_hash: await hashPassword("old-password-123"),
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z"
  };
  token = signAuthToken({ sub: String(user.id), username: String(user.username) });
  database.queryOne.mockReset();
  database.execute.mockReset();

  database.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM users WHERE id = ?") || sql.includes("SELECT * FROM users WHERE id = ?")) return { ...user };
    return undefined;
  });

  database.execute.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.startsWith("UPDATE users SET name = ?")) {
      user.name = params[0];
      user.avatar_data = params[1];
      user.preferred_language = params[2];
    } else if (sql.startsWith("UPDATE users SET password_hash = ?")) {
      user.password_hash = params[0];
    }
    return { affectedRows: 1 };
  });
});

describe("Account settings routes", () => {
  it("updates profile identity, avatar, and preferred language", async () => {
    const avatarData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlR0y8AAAAASUVORK5CYII=";
    const response = await request(createApp())
      .patch("/api/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated User", avatarData, preferredLanguage: "ko" })
      .expect(200);

    expect(response.body.user).toMatchObject({
      username: "settings-user",
      name: "Updated User",
      avatarData,
      preferredLanguage: "ko"
    });
  });

  it("rejects an invalid profile image", async () => {
    const response = await request(createApp())
      .patch("/api/auth/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ avatarData: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" })
      .expect(400);

    expect(response.body.error.code).toBe("INVALID_AVATAR");
  });

  it("verifies the current password before replacing its hash", async () => {
    const rejected = await request(createApp())
      .post("/api/auth/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "wrong-password", newPassword: "new-password-456" })
      .expect(400);
    expect(rejected.body.error.code).toBe("CURRENT_PASSWORD_INCORRECT");

    await request(createApp())
      .post("/api/auth/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "old-password-123", newPassword: "new-password-456" })
      .expect(200, { ok: true });

    await expect(verifyPassword("new-password-456", String(user.password_hash))).resolves.toBe(true);
  });
});
