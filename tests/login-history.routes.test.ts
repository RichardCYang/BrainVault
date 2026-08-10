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

type Attempt = {
  id: string;
  user_id: string;
  ip_address: string;
  country_code: string | null;
  country_dataset_updated_at: string | null;
  outcome: "SUCCESS" | "FAILURE" | "LOCKED";
  attempted_at: string;
};

let user: Record<string, unknown>;
let attempts: Attempt[];

beforeEach(async () => {
  attempts = [];
  user = {
    id: "usr_login_history",
    username: "history-user",
    name: "History User",
    avatar_data: null,
    preferred_language: "ko",
    default_collection_icon: null,
    password_hash: await hashPassword("correct-password-123"),
    auth_version: 1,
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: "2026-07-31T00:00:00.000Z"
  };

  database.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes("FROM user_login_attempts")) {
      return [...attempts].sort((left, right) =>
        right.attempted_at.localeCompare(left.attempted_at) || right.id.localeCompare(left.id)
      );
    }
    return [];
  });
  database.queryOne.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes("FROM users WHERE username = ?")) return { ...user };
    if (sql.includes("EXISTS(SELECT 1 FROM user_totp_credentials")) {
      return { totp_enabled: 0, passkey_count: 0 };
    }
    if (sql.includes("FROM users WHERE id = ?")) return { ...user };
    return undefined;
  });
  database.execute.mockReset().mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("INSERT INTO user_login_attempts")) {
      attempts.push({
        id: String(params[0]),
        user_id: String(params[1]),
        ip_address: String(params[2]),
        country_code: null,
        country_dataset_updated_at: null,
        outcome: params[3] as Attempt["outcome"],
        attempted_at: new Date(Date.now() + attempts.length).toISOString()
      });
    }
    return { affectedRows: 1 };
  });
});

describe("Login history", () => {
  it("records failed and successful sign-in attempts with the normalized client IP", async () => {
    await request(createApp())
      .post("/api/auth/login")
      .send({ username: "history-user", password: "wrong-password" })
      .expect(401);

    const login = await request(createApp())
      .post("/api/auth/login")
      .send({ username: "history-user", password: "correct-password-123" })
      .expect(200);

    expect(attempts.map((attempt) => attempt.outcome)).toEqual(["FAILURE", "SUCCESS"]);
    expect(attempts.every((attempt) => attempt.ip_address === "127.0.0.1")).toBe(true);

    const sessionCookie = login.headers["set-cookie"]?.[0]?.split(";")[0];
    const history = await request(createApp())
      .get("/api/auth/login-history")
      .set("Cookie", sessionCookie as string)
      .expect(200);

    expect(history.body.months).toBe(3);
    expect(history.body.truncated).toBe(false);
    expect(history.body.attempts).toHaveLength(2);
    expect(history.body.attempts[0]).toMatchObject({ outcome: "SUCCESS", ipAddress: "127.0.0.1", countryCode: null });
    expect(history.body.attempts[1]).toMatchObject({ outcome: "FAILURE", ipAddress: "127.0.0.1", countryCode: null });
  });

  it("accepts a month-based period from 1 through 12", async () => {
    const login = await request(createApp())
      .post("/api/auth/login")
      .send({ username: "history-user", password: "correct-password-123" })
      .expect(200);
    const sessionCookie = login.headers["set-cookie"]?.[0]?.split(";")[0];

    const history = await request(createApp())
      .get("/api/auth/login-history?months=6")
      .set("Cookie", sessionCookie as string)
      .expect(200);

    expect(history.body.months).toBe(6);
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("INTERVAL 6 MONTH"),
      ["usr_login_history"]
    );

    await request(createApp())
      .get("/api/auth/login-history?months=13")
      .set("Cookie", sessionCookie as string)
      .expect(400);
  });
});
