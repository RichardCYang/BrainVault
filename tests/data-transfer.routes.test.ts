import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import request from "supertest";
import type { Response } from "superagent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
  pages: new Map<string, Record<string, unknown>>(),
  blocks: new Map<string, Record<string, unknown>>(),
  tags: new Map<string, Record<string, unknown>>(),
  pageTags: [] as Array<{ page_id: string; tag_id: string }>,
  restoreMarker: null as string | null,
  transactionHooks: [] as Array<() => void>,
  failTransactionAfterCallback: false,
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn()
}));

vi.mock("../src/lib/db.js", () => ({
  db: { query: store.query, queryOne: store.queryOne, execute: store.execute },
  transaction: async (fn: (client: unknown) => unknown) => {
    store.transactionHooks.shift()?.();
    const result = await fn({ query: store.query, queryOne: store.queryOne, execute: store.execute });
    if (store.failTransactionAfterCallback) {
      store.failTransactionAfterCallback = false;
      throw new Error("simulated ambiguous transaction response");
    }
    return result;
  }
}));

import { createApp } from "../src/app.js";
import { attachmentUploadRoot, getAttachmentFilePath } from "../src/lib/attachments.js";
import { signAuthToken } from "../src/lib/auth.js";
import { prepareUserDataBackup, writeUserDataBackup } from "../src/lib/data-transfer.js";
import { readZipDirectory, readZipEntryBuffer } from "../src/lib/zip.js";

const userId = "usr_data_transfer";
const pageId = "pag_data_transfer";
const blockId = "blk_data_transfer";
const tagId = "tag_data_transfer";
const originalBytes = Buffer.from([0, 255, 1, 2, 3, 10, 13, 200]);
const token = signAuthToken({ sub: userId, username: "backup-user" });

function binaryParser(response: Response, callback: (error: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = [];
  response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  response.on("end", () => callback(null, Buffer.concat(chunks)));
  response.on("error", (error) => callback(error));
}

beforeEach(async () => {
  store.user = {
    id: userId,
    username: "backup-user",
    name: "Original User",
    avatar_data: null,
    preferred_language: "ko",
    default_collection_icon: "🧠",
    password_hash: "unchanged-password-hash",
    created_at: "2026-07-17 00:00:00.000000",
    updated_at: "2026-07-17 00:00:00.000000"
  };
  store.pages = new Map([[pageId, {
    id: pageId,
    title: "Original Page",
    icon: "📄",
    cover_url: null,
    is_archived: 0,
    is_collection: 0,
    owner_id: userId,
    parent_page_id: null,
    edit_version: 7,
    content_version: 11,
    created_at: "2026-07-17 00:00:00.000000",
    updated_at: "2026-07-17 00:01:00.000000"
  }]]);
  store.blocks = new Map([[blockId, {
    id: blockId,
    page_id: pageId,
    parent_block_id: null,
    type: "ATTACHMENT",
    markdown: "original.bin",
    html_cache: "<p>original.bin</p>",
    checked: 0,
    sort_order: 0,
    metadata: JSON.stringify({ attachment: { originalName: "original.bin", mimeType: "application/octet-stream", size: originalBytes.length } }),
    edit_version: 9,
    created_at: "2026-07-17 00:00:10.000000",
    updated_at: "2026-07-17 00:00:10.000000"
  }]]);
  store.tags = new Map([[tagId, { id: tagId, name: "backup", created_at: "2026-07-17 00:00:00.000000" }]]);
  store.pageTags = [{ page_id: pageId, tag_id: tagId }];
  store.restoreMarker = null;
  store.transactionHooks = [];
  store.failTransactionAfterCallback = false;
  store.query.mockReset();
  store.queryOne.mockReset();
  store.execute.mockReset();

  store.queryOne.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM data_restore_markers")) {
      return store.restoreMarker === params[1] ? { operation_id: store.restoreMarker } : undefined;
    }
    if (sql.includes("SELECT GREATEST(")) {
      const pageVersions = [...store.pages.values()]
        .filter((page) => page.owner_id === params[0])
        .flatMap((page) => [Number(page.edit_version ?? 1), Number(page.content_version ?? 1)]);
      const blockVersions = [...store.blocks.values()]
        .filter((block) => store.pages.get(String(block.page_id))?.owner_id === params[1])
        .map((block) => Number(block.edit_version ?? 1));
      return { max_edit_version: Math.max(0, ...pageVersions, ...blockVersions) };
    }
    if (sql.includes("FROM users WHERE id = ?") || sql.includes("SELECT * FROM users WHERE id = ?")) return { ...store.user };
    return undefined;
  });

  store.query.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM pages WHERE owner_id = ? ORDER BY")) {
      return [...store.pages.values()].filter((page) => page.owner_id === params[0]).map(({ owner_id: _owner, ...page }) => ({ ...page }));
    }
    if (sql.includes("FROM blocks b INNER JOIN pages p") && sql.includes("WHERE p.owner_id = ? ORDER BY")) {
      return [...store.blocks.values()].filter((block) => store.pages.get(String(block.page_id))?.owner_id === params[0]).map((block) => ({ ...block }));
    }
    if (sql.includes("SELECT DISTINCT t.id")) return [...store.tags.values()].map((tag) => ({ ...tag }));
    if (sql.includes("SELECT pt.page_id")) return store.pageTags.map((relation) => ({ ...relation }));
    if (sql.startsWith("SELECT id, owner_id FROM pages WHERE id IN")) {
      return params.flatMap((id) => {
        const page = store.pages.get(String(id));
        return page ? [{ id: page.id, owner_id: page.owner_id }] : [];
      });
    }
    if (sql.includes("SELECT b.id, p.owner_id") && sql.includes("WHERE b.id IN")) {
      return params.flatMap((id) => {
        const block = store.blocks.get(String(id));
        const page = block ? store.pages.get(String(block.page_id)) : null;
        return block && page ? [{ id: block.id, owner_id: page.owner_id }] : [];
      });
    }
    if (sql.includes("FROM tags WHERE")) return [...store.tags.values()].map((tag) => ({ ...tag }));
    return [];
  });

  store.execute.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql === "DELETE FROM pages WHERE owner_id = ?") {
      const pageIds = new Set([...store.pages.values()].filter((page) => page.owner_id === params[0]).map((page) => String(page.id)));
      for (const id of pageIds) store.pages.delete(id);
      for (const [id, block] of store.blocks) if (pageIds.has(String(block.page_id))) store.blocks.delete(id);
      store.pageTags = store.pageTags.filter((relation) => !pageIds.has(relation.page_id));
    } else if (sql.startsWith("UPDATE users SET name = ?")) {
      [store.user.name, store.user.avatar_data, store.user.preferred_language, store.user.default_collection_icon] = params;
    } else if (sql.includes("INSERT INTO pages")) {
      const [id, title, icon, coverUrl, archived, collection, ownerId, parentPageId, editVersion, contentVersion, createdAt, updatedAt] = params;
      store.pages.set(String(id), { id, title, icon, cover_url: coverUrl, is_archived: archived, is_collection: collection, owner_id: ownerId, parent_page_id: parentPageId, edit_version: editVersion, content_version: contentVersion, created_at: createdAt, updated_at: updatedAt });
    } else if (sql.includes("INSERT INTO blocks")) {
      const [id, importedPageId, parentBlockId, type, markdown, htmlCache, checked, sortOrder, metadata, editVersion, createdAt, updatedAt] = params;
      store.blocks.set(String(id), { id, page_id: importedPageId, parent_block_id: parentBlockId, type, markdown, html_cache: htmlCache, checked, sort_order: sortOrder, metadata, edit_version: editVersion, created_at: createdAt, updated_at: updatedAt });
    } else if (sql.startsWith("INSERT INTO tags")) {
      const [id, name, createdAt] = params;
      store.tags.set(String(id), { id, name, created_at: createdAt });
    } else if (sql.startsWith("INSERT INTO page_tags")) {
      store.pageTags.push({ page_id: String(params[0]), tag_id: String(params[1]) });
    } else if (sql.includes("INSERT INTO data_restore_markers")) {
      store.restoreMarker = String(params[1]);
    } else if (sql.startsWith("DELETE FROM data_restore_markers")) {
      if (store.restoreMarker === params[1]) store.restoreMarker = null;
    }
    return { affectedRows: 1 };
  });

  await rm(path.join(attachmentUploadRoot, userId), { recursive: true, force: true });
  await mkdir(path.dirname(getAttachmentFilePath(userId, blockId)), { recursive: true });
  await writeFile(getAttachmentFilePath(userId, blockId), originalBytes);
});

afterAll(async () => {
  await rm(path.join(attachmentUploadRoot, userId), { recursive: true, force: true });
  await rm(path.join(attachmentUploadRoot, ".data-transfer"), { recursive: true, force: true });
});

describe("Complete data transfer routes", () => {

  it("exports the staged attachment snapshot even if the live file changes", async () => {
    const plan = await prepareUserDataBackup(userId);
    await writeFile(getAttachmentFilePath(userId, blockId), Buffer.from("same-session mutation"));

    const zipPath = path.join(attachmentUploadRoot, ".data-transfer", "snapshot-test.zip");
    const output = createWriteStream(zipPath);
    await writeUserDataBackup(plan, output);
    output.end();
    await once(output, "close");

    const entries = await readZipDirectory(zipPath);
    const attachmentEntry = entries.find((entry) => entry.name === `attachments/${blockId}`);
    expect(attachmentEntry).toBeTruthy();
    await expect(readZipEntryBuffer(zipPath, attachmentEntry!, 1024)).resolves.toEqual(originalBytes);
    await rm(zipPath, { force: true });
  });

  it("exports and restores database rows and exact attachment bytes", async () => {
    const exported = await request(createApp())
      .get("/api/data/export")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    expect(exported.headers["content-type"]).toContain("application/zip");
    const zipPath = path.join(attachmentUploadRoot, ".data-transfer", "roundtrip-test.zip");
    await mkdir(path.dirname(zipPath), { recursive: true });
    await writeFile(zipPath, exported.body as Buffer);
    const entries = await readZipDirectory(zipPath);
    const manifestEntry = entries.find((entry) => entry.name === "brainvault-backup.json");
    expect(manifestEntry).toBeTruthy();
    const manifest = JSON.parse((await readZipEntryBuffer(zipPath, manifestEntry!, 1024 * 1024)).toString("utf8"));
    expect(manifest.data.pages[0].title).toBe("Original Page");
    expect(manifest.data.pages[0].edit_version).toBe(7);
    expect(manifest.data.pages[0].content_version).toBe(11);
    expect(manifest.data.blocks[0].edit_version).toBe(9);
    expect(manifest.attachments[0].sha256).toMatch(/^[a-f0-9]{64}$/);

    const stalePageVersion = Number(store.pages.get(pageId)!.edit_version);
    const staleBlockVersion = Number(store.blocks.get(blockId)!.edit_version);
    const staleContentVersion = Number(store.pages.get(pageId)!.content_version);
    store.pages.get(pageId)!.title = "Changed Page";
    store.user.name = "Changed User";
    await writeFile(getAttachmentFilePath(userId, blockId), Buffer.from("changed bytes"));

    const restored = await request(createApp())
      .post("/api/data/import")
      .set("Authorization", `Bearer ${token}`)
      .attach("backup", exported.body as Buffer, { filename: "BrainVault-backup.zip", contentType: "application/zip" })
      .expect(200);

    expect(restored.body.counts).toEqual({ pages: 1, blocks: 1, attachments: 1, tags: 1 });
    expect(store.pages.get(pageId)?.title).toBe("Original Page");
    expect(Number(store.pages.get(pageId)?.edit_version)).toBeGreaterThan(stalePageVersion);
    expect(Number(store.blocks.get(blockId)?.edit_version)).toBeGreaterThan(staleBlockVersion);
    expect(Number(store.pages.get(pageId)?.content_version)).toBeGreaterThan(staleContentVersion);
    expect(store.pages.get(pageId)?.edit_version).toBe(store.blocks.get(blockId)?.edit_version);
    expect(store.pages.get(pageId)?.content_version).toBe(store.blocks.get(blockId)?.edit_version);
    expect(store.user.name).toBe("Original User");
    await expect(readFile(getAttachmentFilePath(userId, blockId))).resolves.toEqual(originalBytes);
  });

  it("aborts without replacing data when the workspace changes during restore validation", async () => {
    const exported = await request(createApp())
      .get("/api/data/export")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    store.transactionHooks = [
      () => undefined,
      () => {
        const page = store.pages.get(pageId)!;
        page.title = "Concurrent Page";
        page.edit_version = Number(page.edit_version) + 1;
      }
    ];

    const response = await request(createApp())
      .post("/api/data/import")
      .set("Authorization", `Bearer ${token}`)
      .attach("backup", exported.body as Buffer, { filename: "BrainVault-backup.zip", contentType: "application/zip" })
      .expect(409);

    expect(response.body.error.code).toBe("DATA_RESTORE_CONFLICT");
    expect(store.pages.get(pageId)?.title).toBe("Concurrent Page");
    await expect(readFile(getAttachmentFilePath(userId, blockId))).resolves.toEqual(originalBytes);
  });

  it("keeps the committed restore when only the transaction response is lost", async () => {
    const exported = await request(createApp())
      .get("/api/data/export")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    store.pages.get(pageId)!.title = "Changed Page";
    await writeFile(getAttachmentFilePath(userId, blockId), Buffer.from("changed bytes"));
    store.transactionHooks = [
      () => undefined,
      () => {
        store.failTransactionAfterCallback = true;
      }
    ];

    await request(createApp())
      .post("/api/data/import")
      .set("Authorization", `Bearer ${token}`)
      .attach("backup", exported.body as Buffer, { filename: "BrainVault-backup.zip", contentType: "application/zip" })
      .expect(200);

    expect(store.pages.get(pageId)?.title).toBe("Original Page");
    await expect(readFile(getAttachmentFilePath(userId, blockId))).resolves.toEqual(originalBytes);
    expect(store.restoreMarker).toBeNull();
  });
});
