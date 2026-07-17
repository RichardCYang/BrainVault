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
import { hashPassword } from "../src/lib/auth.js";

let user: Record<string, unknown>;

beforeEach(async () => {
  user = {
    id: "usr_mfa_login",
    username: "mfa-user",
    name: "MFA User",
    avatar_data: null,
    preferred_language: "ko",
    default_collection_icon: null,
    password_hash: await hashPassword("correct-password-123"),
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z"
  };
  database.query.mockReset().mockResolvedValue([]);
  database.queryOne.mockReset();
  database.execute.mockReset().mockResolvedValue({ affectedRows: 1 });
});

describe("MFA login gate", () => {
  it("returns a temporary MFA session instead of a JWT when a method is configured", async () => {
    database.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE username = ?")) return user;
      if (sql.includes("EXISTS(SELECT 1 FROM user_totp_credentials")) {
        return { totp_enabled: 1, passkey_count: 2 };
      }
      return undefined;
    });

    const response = await request(createApp())
      .post("/api/auth/login")
      .send({ username: "mfa-user", password: "correct-password-123" })
      .expect(200);

    expect(response.body).toMatchObject({
      mfaRequired: true,
      methods: { totp: true, passkey: true },
      expiresInSeconds: 300
    });
    expect(response.body.mfaToken).toEqual(expect.any(String));
    expect(response.body.token).toBeUndefined();
    expect(database.execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO mfa_login_sessions"),
      expect.any(Array)
    );
  });

  it("continues to issue a JWT when no MFA method is configured", async () => {
    database.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE username = ?")) return user;
      if (sql.includes("EXISTS(SELECT 1 FROM user_totp_credentials")) {
        return { totp_enabled: 0, passkey_count: 0 };
      }
      return undefined;
    });

    const response = await request(createApp())
      .post("/api/auth/login")
      .send({ username: "mfa-user", password: "correct-password-123" })
      .expect(200);

    expect(response.body.mfaRequired).toBeUndefined();
    expect(response.body.token).toEqual(expect.any(String));
    expect(response.body.user.username).toBe("mfa-user");
  });
});
