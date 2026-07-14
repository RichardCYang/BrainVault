import { rm, stat } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  blocks: new Map<string, Record<string, unknown>>(),
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
import { attachmentUploadRoot, getAttachmentFilePath } from "../src/lib/attachments.js";

const user = {
  id: "usr_attachment_test",
  username: "attachment-test",
  name: "Attachment Test",
  password_hash: "unused",
  created_at: "2026-07-14T00:00:00.000Z",
  updated_at: "2026-07-14T00:00:00.000Z"
};
const page = {
  id: "pag_attachment_test",
  title: "Attachments",
  icon: null,
  cover_url: null,
  is_archived: 0,
  owner_id: user.id,
  parent_page_id: null,
  created_at: "2026-07-14T00:00:00.000Z",
  updated_at: "2026-07-14T00:00:00.000Z"
};
const token = signAuthToken({ sub: user.id, username: user.username });

beforeEach(async () => {
  database.blocks.clear();
  database.query.mockReset();
  database.queryOne.mockReset();
  database.execute.mockReset();
  await rm(path.join(attachmentUploadRoot, user.id), { recursive: true, force: true });

  database.queryOne.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM users WHERE id = ?")) return user;
    if (sql.includes("FROM pages WHERE id = ? AND owner_id = ?")) return page;
    if (sql.includes("SELECT sort_order FROM blocks")) return undefined;
    if (sql.includes("INNER JOIN pages p") || sql.includes("SELECT * FROM blocks WHERE id = ?")) {
      return database.blocks.get(String(params[0]));
    }
    if (sql.includes("SELECT id FROM blocks WHERE id = ? AND page_id = ?")) {
      return database.blocks.has(String(params[0])) ? { id: params[0] } : undefined;
    }
    return undefined;
  });

  database.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id, parent_block_id, type FROM blocks")) {
      return [...database.blocks.values()].map((block) => ({
        id: block.id,
        parent_block_id: block.parent_block_id,
        type: block.type
      }));
    }
    return [];
  });

  database.execute.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("INSERT INTO blocks")) {
      const [id, pageId, parentBlockId, markdown, htmlCache, sortOrder, metadata] = params;
      database.blocks.set(String(id), {
        id,
        page_id: pageId,
        parent_block_id: parentBlockId,
        type: "ATTACHMENT",
        markdown,
        html_cache: htmlCache,
        checked: 0,
        sort_order: sortOrder,
        metadata,
        created_at: "2026-07-14T00:00:00.000Z",
        updated_at: "2026-07-14T00:00:00.000Z"
      });
    } else if (sql.includes("DELETE FROM blocks WHERE id = ?")) {
      database.blocks.delete(String(params[0]));
    }
    return { affectedRows: 1 };
  });
});

afterAll(async () => {
  await rm(path.join(attachmentUploadRoot, user.id), { recursive: true, force: true });
});

describe("Attachment routes", () => {
  it("uploads, downloads, and deletes a privately stored attachment", async () => {
    const upload = await request(createApp())
      .post(`/api/pages/${page.id}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .field("sortOrder", "0")
      .attach("file", Buffer.from("private attachment contents"), {
        filename: "report.txt",
        contentType: "text/plain"
      })
      .expect(201);

    expect(upload.body.block.type).toBe("ATTACHMENT");
    expect(upload.body.block.markdown).toBe("report.txt");
    expect(upload.body.block.metadata.attachment).toMatchObject({
      originalName: "report.txt",
      mimeType: "text/plain",
      size: 27
    });

    const blockId = upload.body.block.id as string;
    await expect(stat(getAttachmentFilePath(user.id, blockId))).resolves.toMatchObject({});

    const download = await request(createApp())
      .get(`/api/blocks/${blockId}/attachment`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.headers["content-disposition"]).toContain("report.txt");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(download.text).toBe("private attachment contents");

    await request(createApp())
      .delete(`/api/blocks/${blockId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);

    await expect(stat(getAttachmentFilePath(user.id, blockId))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
