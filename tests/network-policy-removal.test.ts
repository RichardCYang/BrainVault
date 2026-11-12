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

beforeEach(() => {
  vi.clearAllMocks();
  database.query.mockResolvedValue([]);
  database.execute.mockResolvedValue({ affectedRows: 1 });
  database.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM users WHERE id = ?")) {
      return {
        id: "usr_retired_policy",
        username: "retired-policy-user",
        name: "Existing User",
        country_login_mode: "OFF",
        auth_version: 1,
        attachment_generation: 1,
        registration_approved: 1,
        // An account from an older installation must remain usable before migration.
        vpn_block_enabled: 1
      };
    }
    if (sql.includes("FROM user_auth_sessions")) return { id: "active-session" };
    throw new Error(`Unexpected account lookup: ${sql}`);
  });
});

describe("retired network access policy", () => {
  it("admits an existing session without connection measurement or retired policy lookups", async () => {
    const token = signAuthToken({ sub: "usr_retired_policy", username: "retired-policy-user", authVersion: 1 });
    const response = await request(createApp())
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body.user.id).toBe("usr_retired_policy");
    expect(database.queryOne.mock.calls.every(([sql]) => !String(sql).includes("vpn_block_enabled"))).toBe(true);
  });

  it("no longer exposes account policy or measurement HTTP endpoints", async () => {
    const app = createApp();
    const token = signAuthToken({ sub: "usr_retired_policy", username: "retired-policy-user", authVersion: 1 });
    await request(app)
      .get("/api/auth/vpn-block-policy")
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
    await request(app)
      .put("/api/auth/vpn-block-policy")
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: true })
      .expect(404);
    for (const endpoint of ["/api/network-verification", "/api/network-verification/receipt"]) {
      await request(app).post(endpoint).set("Authorization", `Bearer ${token}`).send({}).expect(404);
    }
    expect(database.queryOne.mock.calls.every(([sql]) => !String(sql).includes("vpn_block_enabled"))).toBe(true);
  });
});
