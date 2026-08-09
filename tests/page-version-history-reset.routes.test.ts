import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  page: null as Record<string, unknown> | null,
  versions: [] as Array<Record<string, unknown>>,
  resetReceipts: new Map<string, Record<string, unknown>>(),
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

const owner = {
  id: "usr_version_owner",
  username: "version-owner",
  name: "Version Owner",
  password_hash: "unused",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z"
};
const otherUser = { ...owner, id: "usr_other", username: "other-user", name: "Other User" };
const ownerToken = signAuthToken({ sub: owner.id, username: owner.username, authVersion: 1 });
const otherToken = signAuthToken({ sub: otherUser.id, username: otherUser.username, authVersion: 1 });

function receiptKey(ownerId: unknown, mutationId: unknown) {
  return `${String(ownerId)}\u0000${String(mutationId)}`;
}

beforeEach(() => {
  database.page = {
    id: "pag_version_reset",
    title: "Current page",
    icon: "🧠",
    cover_url: null,
    is_archived: 0,
    is_collection: 0,
    owner_id: owner.id,
    parent_page_id: null,
    edit_version: 7,
    content_version: 11,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z"
  };
  database.versions = [
    { id: 1, page_id: "pag_version_reset", revision: 1 },
    { id: 2, page_id: "pag_version_reset", revision: 2 },
    { id: 3, page_id: "pag_version_reset", revision: 3 }
  ];
  database.resetReceipts.clear();
  database.query.mockReset();
  database.queryOne.mockReset();
  database.execute.mockReset();

  database.query.mockResolvedValue([]);
  database.queryOne.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM users WHERE id = ?")) {
      return params[0] === owner.id ? owner : params[0] === otherUser.id ? otherUser : undefined;
    }
    if (sql.includes("SELECT * FROM pages WHERE id = ? AND owner_id = ? FOR UPDATE")) {
      return database.page?.id === params[0] && database.page?.owner_id === params[1] ? database.page : undefined;
    }
    if (sql.includes("FROM page_version_reset_mutations")) {
      return database.resetReceipts.get(receiptKey(params[0], params[1]));
    }
    if (sql.includes("SELECT edit_version, content_version FROM pages WHERE id = ?")) {
      const page = database.page;
      if (page && page.id === params[0]) {
        return { edit_version: page.edit_version, content_version: page.content_version };
      }
      return undefined;
    }
    if (sql.includes("SELECT MAX(revision) AS revision FROM page_versions")) {
      return { revision: database.versions.reduce((max, row) => Math.max(max, Number(row.revision)), 0) || null };
    }
    return undefined;
  });

  database.execute.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("INSERT INTO page_version_reset_mutations")) {
      const key = receiptKey(params[0], params[1]);
      if (database.resetReceipts.has(key)) {
        throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
      }
      database.resetReceipts.set(key, {
        page_id: params[2],
        request_hash: params[3],
        revision: null,
        deleted_count: null
      });
      return { affectedRows: 1 };
    }
    if (sql.includes("UPDATE page_version_reset_mutations")) {
      const key = receiptKey(params[2], params[3]);
      const receipt = database.resetReceipts.get(key);
      if (!receipt) return { affectedRows: 0 };
      receipt.revision = params[0];
      receipt.deleted_count = params[1];
      return { affectedRows: 1 };
    }
    if (sql.includes("DELETE FROM page_versions WHERE page_id = ?")) {
      const before = database.versions.length;
      database.versions = database.versions.filter((row) => row.page_id !== params[0]);
      return { affectedRows: before - database.versions.length };
    }
    if (sql.includes("INSERT INTO page_versions")) {
      const id = database.versions.length + 100;
      database.versions.push({
        id,
        page_id: params[0],
        revision: params[1],
        page_edit_version: params[2],
        page_content_version: params[3],
        actors: params[4],
        source: params[5],
        change_count: params[6],
        change_summary: params[7],
        changes: params[8]
      });
      return { affectedRows: 1, insertId: id };
    }
    return { affectedRows: 0 };
  });
});

describe("Page version history reset", () => {
  it("deletes every prior row and creates a fresh revision 1 baseline without rewinding edit counters", async () => {
    const response = await request(createApp())
      .delete("/api/pages/pag_version_reset/versions")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ mutationId: "mut_reset_once" })
      .expect(200);

    expect(response.body).toEqual({ revision: 1, deletedCount: 3, replayed: false });
    expect(database.versions).toHaveLength(1);
    expect(database.versions[0]).toMatchObject({
      page_id: "pag_version_reset",
      revision: 1,
      page_edit_version: 7,
      page_content_version: 11,
      source: "RESET"
    });
    expect(JSON.parse(String(database.versions[0].changes))).toEqual([
      expect.objectContaining({
        kind: "history-started",
        page: expect.objectContaining({ title: "Current page", icon: "🧠" })
      })
    ]);
  });

  it("replays the committed result without deleting history created after a lost response", async () => {
    await request(createApp())
      .delete("/api/pages/pag_version_reset/versions")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ mutationId: "mut_reset_lost_response" })
      .expect(200);

    database.versions.push({
      id: 200,
      page_id: "pag_version_reset",
      revision: 2,
      source: "EDIT_AFTER_RESET"
    });

    const replay = await request(createApp())
      .delete("/api/pages/pag_version_reset/versions")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ mutationId: "mut_reset_lost_response" })
      .expect(200);

    expect(replay.body).toEqual({ revision: 1, deletedCount: 3, replayed: true });
    expect(database.versions).toHaveLength(2);
    expect(database.versions.some((version) => version.source === "EDIT_AFTER_RESET")).toBe(true);
  });

  it("does not allow a non-owner to erase the page history", async () => {
    const response = await request(createApp())
      .delete("/api/pages/pag_version_reset/versions")
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ mutationId: "mut_reset_other" })
      .expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(database.versions).toHaveLength(3);
    expect(database.execute).not.toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM page_versions"),
      expect.anything()
    );
  });

  it("requires a mutation id so ambiguous retries cannot silently become new resets", async () => {
    const response = await request(createApp())
      .delete("/api/pages/pag_version_reset/versions")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({})
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(database.versions).toHaveLength(3);
  });
});
