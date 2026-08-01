import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import type { DbClient } from "../src/lib/db.js";
import { evaluatePasswordLogin } from "../src/lib/login-lockout.js";

type LockState = {
  failed_login_attempts: number;
  last_failed_login_at: Date | null;
  login_locked_until: Date | null;
};

function createLockoutClient(state: LockState) {
  return {
    query: async () => [],
    queryOne: async () => ({ ...state }),
    execute: async (sql: string, params: readonly unknown[]) => {
      if (!sql.includes("UPDATE users")) return { affectedRows: 0 };
      if (params.length === 1) {
        state.failed_login_attempts = 0;
        state.last_failed_login_at = null;
        state.login_locked_until = null;
      } else {
        state.failed_login_attempts = Number(params[0]);
        state.last_failed_login_at = params[1] as Date;
        state.login_locked_until = params[2] as Date | null;
      }
      return { affectedRows: 1 };
    }
  } as unknown as DbClient;
}

describe("Account password lockout", () => {
  it("persists exponential backoff across distributed source addresses", async () => {
    const state: LockState = {
      failed_login_attempts: 0,
      last_failed_login_at: null,
      login_locked_until: null
    };
    const client = createLockoutClient(state);
    const startedAt = Date.parse("2026-08-01T12:00:00.000Z");

    for (let attempt = 0; attempt < env.AUTH_LOGIN_LOCK_THRESHOLD; attempt += 1) {
      await expect(evaluatePasswordLogin(client, "usr_lockout", false, startedAt + attempt)).resolves.toBe("DENIED");
    }

    expect(state.failed_login_attempts).toBe(env.AUTH_LOGIN_LOCK_THRESHOLD);
    expect(state.login_locked_until?.getTime()).toBe(startedAt + env.AUTH_LOGIN_LOCK_THRESHOLD - 1 + env.AUTH_LOGIN_LOCK_BASE_MS);
    await expect(evaluatePasswordLogin(client, "usr_lockout", true, startedAt + env.AUTH_LOGIN_LOCK_THRESHOLD)).resolves.toBe("DENIED");

    const afterLock = (state.login_locked_until?.getTime() ?? startedAt) + 1;
    await expect(evaluatePasswordLogin(client, "usr_lockout", true, afterLock)).resolves.toBe("ALLOWED");
    expect(state).toEqual({
      failed_login_attempts: 0,
      last_failed_login_at: null,
      login_locked_until: null
    });
  });
});
