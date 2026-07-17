import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  page: {} as Record<string, unknown>,
  block: {} as Record<string, unknown>,
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn()
}));

vi.mock("../src/lib/db.js", () => ({
  db: {
    query: database.query,
    queryOne: database.queryOne,
    execute: database.execute
  },
  transaction: async (fn: (client: unknown) => unknown) =>
    fn({ query: database.query, queryOne: database.queryOne, execute: database.execute })
}));

import { createApp } from "../src/app.js";
import { signAuthToken } from "../src/lib/auth.js";

const user = {
  id: "usr_edit_conflict",
  username: "edit-conflict",
  name: "Edit Conflict",
  password_hash: "unused",
  created_at: "2026-07-17T00:00:00.000Z",
  updated_at: "2026-07-17T00:00:00.000Z"
};
const token = signAuthToken({ sub: user.id, username: user.username });

beforeEach(() => {
  database.page = {
    id: "pag_conflict",
    title: "Original title",
    icon: null,
    cover_url: null,
    is_archived: 0,
    is_collection: 0,
    owner_id: user.id,
    parent_page_id: null,
    edit_version: 1,
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z"
  };
  database.block = {
    id: "blk_conflict",
    page_id: database.page.id,
    parent_block_id: null,
    type: "MARKDOWN",
    markdown: "Original block",
    html_cache: "<p>Original block</p>",
    checked: 0,
    sort_order: 0,
    metadata: null,
    edit_version: 1,
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z"
  };
  database.query.mockReset();
  database.queryOne.mockReset();
  database.execute.mockReset();

  database.query.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("SELECT id, parent_block_id, type, edit_version FROM blocks") && sql.includes("FOR UPDATE")) {
      return params[0] === database.page.id ? [database.block] : [];
    }
    return [];
  });
  database.queryOne.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM users WHERE id = ?")) return user;
    if (sql.includes("FROM pages WHERE id = ? AND owner_id = ?")) {
      return params[0] === database.page.id ? database.page : undefined;
    }
    if (sql.includes("INNER JOIN pages p") && sql.includes("WHERE b.id = ?")) {
      return params[0] === database.block.id ? database.block : undefined;
    }
    if (sql.includes("SELECT * FROM blocks WHERE id = ?")) {
      return params[0] === database.block.id ? database.block : undefined;
    }
    if (sql.includes("SELECT parent_block_id FROM blocks")) return undefined;
    return undefined;
  });

  database.execute.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.startsWith("UPDATE blocks SET")) {
      const expectedVersion = Number(params.at(-1));
      if (expectedVersion !== Number(database.block.edit_version)) return { affectedRows: 0 };
      database.block.markdown = params[0];
      database.block.html_cache = params[1];
      database.block.edit_version = Number(database.block.edit_version) + 1;
      return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE pages SET")) {
      const expectedVersion = Number(params.at(-1));
      if (expectedVersion !== Number(database.page.edit_version)) return { affectedRows: 0 };
      database.page.title = params[0];
      database.page.edit_version = Number(database.page.edit_version) + 1;
      return { affectedRows: 1 };
    }
    return { affectedRows: 1 };
  });
});

describe("Optimistic edit conflict protection", () => {
  it("rejects a stale block write instead of overwriting the newer block", async () => {
    const first = await request(createApp())
      .patch(`/api/blocks/${database.block.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ markdown: "Newer block", expectedVersion: 1 })
      .expect(200);

    expect(first.body.block.version).toBe(2);

    const stale = await request(createApp())
      .patch(`/api/blocks/${database.block.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ markdown: "Stale block", expectedVersion: 1 })
      .expect(409);

    expect(stale.body.error.code).toBe("BLOCK_EDIT_CONFLICT");
    expect(database.block.markdown).toBe("Newer block");
  });

  it("rejects a stale page-title write instead of overwriting the newer title", async () => {
    const first = await request(createApp())
      .patch(`/api/pages/${database.page.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Newer title", expectedVersion: 1 })
      .expect(200);

    expect(first.body.page.version).toBe(2);

    const stale = await request(createApp())
      .patch(`/api/pages/${database.page.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Stale title", expectedVersion: 1 })
      .expect(409);

    expect(stale.body.error.code).toBe("PAGE_EDIT_CONFLICT");
    expect(database.page.title).toBe("Newer title");
  });

  it("rejects a stale block deletion instead of deleting newer content", async () => {
    database.block.edit_version = 2;

    const response = await request(createApp())
      .delete(`/api/blocks/${database.block.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ expectedVersions: [{ id: database.block.id, version: 1 }] })
      .expect(409);

    expect(response.body.error.code).toBe("BLOCK_EDIT_CONFLICT");
    expect(database.execute).not.toHaveBeenCalledWith("DELETE FROM blocks WHERE id = ?", [database.block.id]);
  });
});
