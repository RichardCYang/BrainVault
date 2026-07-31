import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  blocks: new Map<string, Record<string, unknown>>(),
  receipts: new Map<string, { page_id: string; request_hash: string | null }>(),
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn()
}));

vi.mock("../src/lib/db.js", () => ({
  db: { query: database.query, queryOne: database.queryOne, execute: database.execute },
  transaction: async (fn: (client: unknown) => unknown) =>
    fn({ query: database.query, queryOne: database.queryOne, execute: database.execute })
}));

import { createApp } from "../src/app.js";
import { signAuthToken } from "../src/lib/auth.js";

const user = {
  id: "usr_reorder",
  username: "reorder",
  name: "Reorder",
  password_hash: "unused",
  created_at: "2026-07-17T00:00:00.000Z",
  updated_at: "2026-07-17T00:00:00.000Z"
};
const page = {
  id: "pag_reorder",
  title: "Reorder",
  icon: null,
  cover_url: null,
  is_archived: 0,
  is_collection: 0,
  owner_id: user.id,
  parent_page_id: null,
  edit_version: 1,
  content_version: 1,
  created_at: "2026-07-17T00:00:00.000Z",
  updated_at: "2026-07-17T00:00:00.000Z"
};
const token = signAuthToken({ sub: user.id, username: user.username, authVersion: 1 });

function makeBlock(id: string, sortOrder: number) {
  return {
    id,
    page_id: page.id,
    parent_block_id: null,
    type: "MARKDOWN",
    markdown: id,
    html_cache: `<p>${id}</p>`,
    checked: 0,
    sort_order: sortOrder,
    metadata: null,
    edit_version: 1,
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z"
  };
}

function reorderBody(firstVersion = 1, secondVersion = 1, mutationId?: string) {
  return {
    ...(mutationId ? { mutationId } : {}),
    items: [
      { id: "blk_second", sortOrder: 0, parentBlockId: null, expectedVersion: secondVersion },
      { id: "blk_first", sortOrder: 1, parentBlockId: null, expectedVersion: firstVersion }
    ]
  };
}

beforeEach(() => {
  page.content_version = 1;
  database.blocks = new Map([
    ["blk_first", makeBlock("blk_first", 0)],
    ["blk_second", makeBlock("blk_second", 1)]
  ]);
  database.receipts = new Map();
  database.query.mockReset();
  database.queryOne.mockReset();
  database.execute.mockReset();

  database.queryOne.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM users WHERE id = ?")) return user;
    if (sql.includes("FROM pages WHERE id = ? AND owner_id = ?")) return page;
    if (sql.includes("SELECT * FROM pages WHERE id = ?")) return page;
    if (sql.includes("FROM block_order_mutations")) {
      return database.receipts.get(`${String(params[0])}:${String(params[1])}`);
    }
    return undefined;
  });

  database.query.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (params[0] !== page.id) return [];
    if (sql.includes("SELECT id, parent_block_id, edit_version FROM blocks")) {
      return [...database.blocks.values()].map((block) => ({
        id: block.id,
        parent_block_id: block.parent_block_id,
        edit_version: block.edit_version
      }));
    }
    if (sql.includes("SELECT * FROM blocks WHERE page_id = ?")) {
      return [...database.blocks.values()].sort(
        (left, right) => Number(left.sort_order) - Number(right.sort_order) || String(left.id).localeCompare(String(right.id))
      );
    }
    return [];
  });

  database.execute.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("INSERT INTO block_order_mutations")) {
      database.receipts.set(`${String(params[0])}:${String(params[1])}`, {
        page_id: String(params[2]),
        request_hash: String(params[3])
      });
      return { affectedRows: 1 };
    }
    if (sql.includes("SET content_version = content_version + 1")) {
      page.content_version = Number(page.content_version) + 1;
      return { affectedRows: 1 };
    }
    if (!sql.includes("UPDATE blocks")) return { affectedRows: 1 };
    const withParent = sql.includes("parent_block_id = ?");
    const blockId = String(params[withParent ? 2 : 1]);
    const expectedVersion = Number(params[withParent ? 3 : 2]);
    const block = database.blocks.get(blockId);
    if (!block || Number(block.edit_version) !== expectedVersion) return { affectedRows: 0 };
    block.sort_order = Number(params[0]);
    if (withParent) block.parent_block_id = params[1];
    block.edit_version = Number(block.edit_version) + 1;
    return { affectedRows: 1 };
  });
});

describe("Block reorder conflict protection", () => {
  it("increments edit versions when block order changes", async () => {
    const response = await request(createApp())
      .post(`/api/pages/${page.id}/blocks/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send(reorderBody())
      .expect(200);

    expect(response.body.blocks.map((block: { id: string }) => block.id)).toEqual(["blk_second", "blk_first"]);
    expect(database.blocks.get("blk_first")?.edit_version).toBe(2);
    expect(database.blocks.get("blk_second")?.edit_version).toBe(2);
    expect(response.body.pageContentVersion).toBe(2);
    expect(page.content_version).toBe(2);
  });

  it("replays a committed reorder without applying it twice when the response was lost", async () => {
    const mutationId = "mut_reorder_response_lost";
    const first = await request(createApp())
      .post(`/api/pages/${page.id}/blocks/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send(reorderBody(1, 1, mutationId))
      .expect(200);

    const replay = await request(createApp())
      .post(`/api/pages/${page.id}/blocks/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send(reorderBody(1, 1, mutationId))
      .expect(200);

    expect(first.body.blocks.map((block: { id: string }) => block.id)).toEqual(["blk_second", "blk_first"]);
    expect(replay.body.blocks.map((block: { id: string }) => block.id)).toEqual(["blk_second", "blk_first"]);
    expect(database.blocks.get("blk_first")?.edit_version).toBe(2);
    expect(database.blocks.get("blk_second")?.edit_version).toBe(2);
    expect(page.content_version).toBe(2);
  });

  it("rejects a reused reorder mutation id when the requested order differs", async () => {
    const mutationId = "mut_reorder_collision";
    await request(createApp())
      .post(`/api/pages/${page.id}/blocks/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send(reorderBody(1, 1, mutationId))
      .expect(200);

    const collision = await request(createApp())
      .post(`/api/pages/${page.id}/blocks/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        mutationId,
        items: [
          { id: "blk_first", sortOrder: 0, parentBlockId: null, expectedVersion: 1 },
          { id: "blk_second", sortOrder: 1, parentBlockId: null, expectedVersion: 1 }
        ]
      })
      .expect(409);

    expect(collision.body.error.code).toBe("MUTATION_ID_REUSED");
    expect(database.blocks.get("blk_second")?.sort_order).toBe(0);
    expect(database.blocks.get("blk_first")?.sort_order).toBe(1);
    expect(page.content_version).toBe(2);
  });

  it("rejects a stale reorder instead of overwriting a newer order", async () => {
    await request(createApp())
      .post(`/api/pages/${page.id}/blocks/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send(reorderBody())
      .expect(200);

    const response = await request(createApp())
      .post(`/api/pages/${page.id}/blocks/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [
          { id: "blk_first", sortOrder: 0, parentBlockId: null, expectedVersion: 1 },
          { id: "blk_second", sortOrder: 1, parentBlockId: null, expectedVersion: 1 }
        ]
      })
      .expect(409);

    expect(response.body.error.code).toBe("BLOCK_EDIT_CONFLICT");
    expect(database.blocks.get("blk_second")?.sort_order).toBe(0);
    expect(database.blocks.get("blk_first")?.sort_order).toBe(1);
  });

  it("rejects reorder when one block received a newer content edit", async () => {
    database.blocks.get("blk_first")!.edit_version = 2;

    const response = await request(createApp())
      .post(`/api/pages/${page.id}/blocks/reorder`)
      .set("Authorization", `Bearer ${token}`)
      .send(reorderBody())
      .expect(409);

    expect(response.body.error.code).toBe("BLOCK_EDIT_CONFLICT");
    expect(database.execute).not.toHaveBeenCalled();
  });
});
