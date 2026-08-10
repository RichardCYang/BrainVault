import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import request from "supertest";
import type { Response } from "superagent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
  users: new Map<string, { id: string; username: string }>(),
  pages: new Map<string, Record<string, unknown>>(),
  blocks: new Map<string, Record<string, unknown>>(),
  tags: new Map<string, Record<string, unknown>>(),
  pageTags: [] as Array<{ page_id: string; tag_id: string }>,
  customIcons: new Map<string, {
    id: string; user_id: string; file_path: string; last_used_at: string; created_at: string;
  }>(),
  customIconRemovals: new Map<string, { user_id: string; value_hash: string; removed_at: string }>(),
  shares: [] as Array<{
    page_id: string;
    user_id: string;
    permission: string;
    shared_by: string;
    shared_at: string;
  }>,
  collaborationUpdates: new Map<string, number>(),
  collaborationMaterialized: new Map<string, number>(),
  collaborationMaterializationVersion: new Map<string, number>(),
  restoreMarker: null as string | null,
  transactionHooks: [] as Array<() => void | Promise<void>>,
  failTransactionAfterCallback: false,
  restoreEvents: [] as string[],
  disconnectPageCollaborators: vi.fn(),
  disconnectSharedUser: vi.fn(),
  broadcastCanonicalAttachment: vi.fn(),
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn()
}));

vi.mock("../src/lib/db.js", () => ({
  db: { query: store.query, queryOne: store.queryOne, execute: store.execute },
  transaction: async (fn: (client: unknown) => unknown) => {
    await store.transactionHooks.shift()?.();
    const result = await fn({ query: store.query, queryOne: store.queryOne, execute: store.execute });
    if (store.failTransactionAfterCallback) {
      store.failTransactionAfterCallback = false;
      throw new Error("simulated ambiguous transaction response");
    }
    return result;
  }
}));

vi.mock("../src/lib/collaboration-server.js", () => ({
  collaborationTicketProtocolPrefix: "brainvault-ticket.",
  collaborationWebSocketProtocol: "brainvault-yjs-v2",
  disconnectPageCollaborators: (pageId: string, reason?: string) => {
    store.restoreEvents.push(`disconnect:${pageId}`);
    return store.disconnectPageCollaborators(pageId, reason);
  },
  disconnectSharedUser: store.disconnectSharedUser,
  broadcastCanonicalAttachment: store.broadcastCanonicalAttachment
}));

import { createApp } from "../src/app.js";
import { attachmentUploadRoot, getAttachmentFilePath } from "../src/lib/attachments.js";
import { customIconUploadRoot } from "../src/lib/custom-icons.js";
import { signAuthToken } from "../src/lib/auth.js";
import { prepareUserDataBackup, writeUserDataBackup } from "../src/lib/data-transfer.js";
import { readZipDirectory, readZipEntryBuffer } from "../src/lib/zip.js";

const userId = "usr_data_transfer";
const pageId = "pag_data_transfer";
const blockId = "blk_data_transfer";
const tagId = "tag_data_transfer";
const originalBytes = Buffer.from([0, 255, 1, 2, 3, 10, 13, 200]);
const token = signAuthToken({ sub: userId, username: "backup-user", authVersion: 1 });

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
    theme: "dark",
    password_hash: "unchanged-password-hash",
    created_at: "2026-07-17 00:00:00.000000",
    updated_at: "2026-07-17 00:00:00.000000"
  };
  store.users = new Map([
    [userId, { id: userId, username: "backup-user" }],
    ["usr_collaborator", { id: "usr_collaborator", username: "collaborator" }]
  ]);
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
  store.customIcons = new Map();
  store.customIconRemovals = new Map();
  store.shares = [];
  store.collaborationUpdates = new Map();
  store.collaborationMaterialized = new Map();
  store.collaborationMaterializationVersion = new Map();
  store.restoreMarker = null;
  store.transactionHooks = [];
  store.failTransactionAfterCallback = false;
  store.restoreEvents = [];
  store.disconnectPageCollaborators.mockReset();
  store.disconnectSharedUser.mockReset();
  store.broadcastCanonicalAttachment.mockReset();
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
    if (sql.includes("LEFT JOIN page_yjs_updates")) {
      return params.map((id) => ({
        page_id: String(id),
        latest_update_id: store.collaborationUpdates.get(String(id)) ?? 0,
        materialized_update_id: store.collaborationMaterialized.get(String(id)) ?? 0,
        materialization_version: store.collaborationMaterializationVersion.get(String(id)) ?? 0
      }));
    }
    if (sql.includes("FROM pages WHERE owner_id = ? ORDER BY")) {
      return [...store.pages.values()].filter((page) => page.owner_id === params[0]).map(({ owner_id: _owner, ...page }) => ({ ...page }));
    }
    if (sql.includes("FROM blocks b INNER JOIN pages p") && sql.includes("WHERE p.owner_id = ? ORDER BY")) {
      return [...store.blocks.values()].filter((block) => store.pages.get(String(block.page_id))?.owner_id === params[0]).map((block) => ({ ...block }));
    }
    if (sql.includes("u.username AS shared_username")) {
      return store.shares
        .filter((share) => store.pages.get(share.page_id)?.owner_id === params[0])
        .map((share) => ({
          page_id: share.page_id,
          shared_user_id: share.user_id,
          shared_username: store.users.get(share.user_id)?.username,
          permission: share.permission,
          created_at: share.shared_at
        }));
    }
    if (sql.includes("FROM page_shares ps INNER JOIN pages p")) {
      return store.shares
        .filter((share) => store.pages.get(share.page_id)?.owner_id === params[0])
        .map((share) => ({ ...share }));
    }
    if (sql.startsWith("SELECT id, username FROM users WHERE username IN")) {
      const requested = new Set(params.map((value) => String(value).toLowerCase()));
      return [...store.users.values()].filter((user) => requested.has(user.username.toLowerCase()));
    }
    if (sql.startsWith("SELECT id, username FROM users WHERE id IN")) {
      const requested = new Set(params.map((value) => String(value)));
      return [...store.users.values()].filter((user) => requested.has(user.id));
    }
    if (sql.startsWith("SELECT id FROM users WHERE id IN")) {
      return params.flatMap((id) => store.users.has(String(id)) ? [{ id: String(id) }] : []);
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
    if (sql.includes("FROM custom_icons") && sql.includes("WHERE user_id = ?") && !sql.includes("id IN")) {
      return [...store.customIcons.values()]
        .filter((icon) => icon.user_id === params[0])
        .map((icon) => ({ ...icon }));
    }
    if (sql.includes("FROM custom_icon_library_removals") && sql.includes("WHERE user_id = ?")) {
      return [...store.customIconRemovals.values()]
        .filter((removal) => removal.user_id === params[0])
        .map((removal) => ({ value_hash: removal.value_hash, removed_at: removal.removed_at }));
    }
    if (sql.startsWith("SELECT id, user_id FROM custom_icons WHERE id IN")) {
      return params.flatMap((id) => {
        const icon = store.customIcons.get(String(id));
        return icon ? [{ id: icon.id, user_id: icon.user_id }] : [];
      });
    }
    if (sql.includes("FROM tags WHERE")) return [...store.tags.values()].map((tag) => ({ ...tag }));
    return [];
  });

  store.execute.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql === "DELETE FROM pages WHERE owner_id = ?") {
      const pageIds = new Set([...store.pages.values()].filter((page) => page.owner_id === params[0]).map((page) => String(page.id)));
      for (const id of pageIds) store.pages.delete(id);
      store.restoreEvents.push("delete-pages");
      for (const [id, block] of store.blocks) if (pageIds.has(String(block.page_id))) store.blocks.delete(id);
      store.pageTags = store.pageTags.filter((relation) => !pageIds.has(relation.page_id));
      store.shares = store.shares.filter((share) => !pageIds.has(share.page_id));
    } else if (sql.startsWith("UPDATE users")) {
      [store.user.name, store.user.avatar_data, store.user.preferred_language, store.user.default_collection_icon] = params;
      if (params[4] !== null && params[4] !== undefined) store.user.theme = params[4];
    } else if (sql.includes("INSERT INTO pages")) {
      const [id, title, icon, coverUrl, coverPositionX, coverPositionY, archived, collection, ownerId, parentPageId, editVersion, contentVersion, createdAt, updatedAt] = params;
      store.pages.set(String(id), { id, title, icon, cover_url: coverUrl, cover_position_x: coverPositionX, cover_position_y: coverPositionY, is_archived: archived, is_collection: collection, owner_id: ownerId, parent_page_id: parentPageId, edit_version: editVersion, content_version: contentVersion, created_at: createdAt, updated_at: updatedAt });
    } else if (sql.includes("INSERT INTO blocks")) {
      const [id, importedPageId, parentBlockId, type, markdown, htmlCache, checked, sortOrder, metadata, editVersion, createdAt, updatedAt] = params;
      store.blocks.set(String(id), { id, page_id: importedPageId, parent_block_id: parentBlockId, type, markdown, html_cache: htmlCache, checked, sort_order: sortOrder, metadata, edit_version: editVersion, created_at: createdAt, updated_at: updatedAt });
    } else if (sql.startsWith("INSERT INTO tags")) {
      const [id, name, createdAt] = params;
      store.tags.set(String(id), { id, name, created_at: createdAt });
    } else if (sql.startsWith("INSERT INTO page_tags")) {
      store.pageTags.push({ page_id: String(params[0]), tag_id: String(params[1]) });
    } else if (sql.includes("INSERT INTO page_shares")) {
      store.shares.push({
        page_id: String(params[0]),
        user_id: String(params[1]),
        permission: String(params[2]),
        shared_by: String(params[3]),
        shared_at: String(params[4])
      });
    } else if (sql === "DELETE FROM custom_icons WHERE user_id = ?") {
      for (const [id, icon] of store.customIcons) if (icon.user_id === params[0]) store.customIcons.delete(id);
    } else if (sql === "DELETE FROM custom_icon_library_removals WHERE user_id = ?") {
      for (const [key, removal] of store.customIconRemovals) if (removal.user_id === params[0]) store.customIconRemovals.delete(key);
    } else if (sql.includes("INSERT INTO custom_icons")) {
      const [id, ownerId, filePath, lastUsedAt, createdAt] = params;
      store.customIcons.set(String(id), {
        id: String(id), user_id: String(ownerId), file_path: String(filePath),
        last_used_at: String(lastUsedAt), created_at: String(createdAt)
      });
    } else if (sql.includes("INSERT INTO custom_icon_library_removals")) {
      const [ownerId, valueHash, removedAt] = params;
      store.customIconRemovals.set(String(valueHash), {
        user_id: String(ownerId), value_hash: String(valueHash), removed_at: String(removedAt)
      });
    } else if (sql.includes("INSERT INTO data_restore_markers")) {
      store.restoreMarker = String(params[1]);
    } else if (sql.startsWith("DELETE FROM data_restore_markers")) {
      if (store.restoreMarker === params[1]) store.restoreMarker = null;
    }
    return { affectedRows: 1 };
  });

  await rm(path.join(attachmentUploadRoot, userId), { recursive: true, force: true });
  await rm(path.join(customIconUploadRoot, userId), { recursive: true, force: true });
  await mkdir(path.dirname(getAttachmentFilePath(userId, blockId)), { recursive: true });
  await writeFile(getAttachmentFilePath(userId, blockId), originalBytes);
});

afterAll(async () => {
  await rm(path.join(attachmentUploadRoot, userId), { recursive: true, force: true });
  await rm(path.join(customIconUploadRoot, userId), { recursive: true, force: true });
  await rm(path.join(attachmentUploadRoot, ".data-transfer"), { recursive: true, force: true });
});

describe("Complete data transfer routes", () => {
  it("locks workspace pages before establishing the export snapshot", async () => {
    const plan = await prepareUserDataBackup(userId);
    try {
      const pageLockCall = store.query.mock.calls.findIndex(([sql]) =>
        typeof sql === "string" && sql.includes("FROM pages WHERE owner_id = ? ORDER BY") && sql.includes("FOR UPDATE")
      );
      const accountSnapshotCall = store.queryOne.mock.calls.findIndex(([sql]) =>
        typeof sql === "string" && sql.includes("SELECT id, username, name") && sql.includes("FROM users WHERE id = ?")
      );

      expect(pageLockCall).toBeGreaterThanOrEqual(0);
      expect(accountSnapshotCall).toBeGreaterThanOrEqual(0);
      expect(store.query.mock.invocationCallOrder[pageLockCall]).toBeLessThan(
        store.queryOne.mock.invocationCallOrder[accountSnapshotCall]
      );
    } finally {
      await rm(plan.operationRoot, { recursive: true, force: true });
    }
  });

  it("refuses to export a workspace with persisted collaboration updates that are not materialized", async () => {
    store.collaborationUpdates.set(pageId, 12);
    store.collaborationMaterialized.set(pageId, 11);
    store.collaborationMaterializationVersion.set(pageId, 1);

    const response = await request(createApp())
      .get("/api/data/export")
      .set("Authorization", `Bearer ${token}`)
      .expect(409);

    expect(response.body.error.code).toBe("COLLABORATION_CHANGES_PENDING");
    expect(response.body.error.details).toMatchObject({
      pendingPageCount: 1,
      pages: [{ pageId, latestUpdateId: 12, materializedUpdateId: 11 }]
    });
  });

  it("refuses an equal-ID legacy checkpoint that was not derived by the current server", async () => {
    store.collaborationUpdates.set(pageId, 12);
    store.collaborationMaterialized.set(pageId, 12);
    store.collaborationMaterializationVersion.set(pageId, 0);

    const response = await request(createApp())
      .get("/api/data/export")
      .set("Authorization", `Bearer ${token}`)
      .expect(409);

    expect(response.body.error.code).toBe("COLLABORATION_CHANGES_PENDING");
    expect(response.body.error.details).toMatchObject({
      pendingPageCount: 1,
      pages: [{
        pageId,
        latestUpdateId: 12,
        materializedUpdateId: 12,
        materializationVersion: 0
      }]
    });
  });

  it("refuses to restore over collaboration updates that become pending before the final lock", async () => {
    const exported = await request(createApp())
      .get("/api/data/export")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    store.pages.get(pageId)!.title = "Must survive";
    store.transactionHooks = [
      () => undefined,
      () => {
        store.collaborationUpdates.set(pageId, 13);
        store.collaborationMaterialized.set(pageId, 12);
        store.collaborationMaterializationVersion.set(pageId, 1);
      }
    ];

    const response = await request(createApp())
      .post("/api/data/import")
      .set("Authorization", `Bearer ${token}`)
      .attach("backup", exported.body as Buffer, { filename: "BrainVault-backup.zip", contentType: "application/zip" })
      .expect(409);

    expect(response.body.error.code).toBe("COLLABORATION_CHANGES_PENDING");
    expect(store.pages.get(pageId)?.title).toBe("Must survive");
    await expect(readFile(getAttachmentFilePath(userId, blockId))).resolves.toEqual(originalBytes);
  });

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

  it("exports and restores every uploaded custom icon file plus library state", async () => {
    const activeIconId = "cicon_backup_active";
    const removedIconId = "cicon_backup_removed";
    const activeFileName = `${activeIconId}.png`;
    const removedFileName = `${removedIconId}.webp`;
    const activePublicPath = `/upload/icons/${userId}/${activeFileName}`;
    const removedPublicPath = `/upload/icons/${userId}/${removedFileName}`;
    const activeValue = `image:${activePublicPath}`;
    const removedValue = `image:${removedPublicPath}`;
    const activeBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("brainvault-active-icon")
    ]);
    const removedBytes = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WEBPbrainvault-removed-icon")
    ]);
    const removedHash = createHash("sha256").update(removedValue, "utf8").digest("hex");
    const retainedAttachmentId = "blk_retained_ambiguous";
    const retainedAttachmentBytes = Buffer.from("preserved after ambiguous attachment commit");
    const retainedAttachmentPath = getAttachmentFilePath(userId, retainedAttachmentId);
    const iconDirectory = path.join(customIconUploadRoot, userId);
    await mkdir(iconDirectory, { recursive: true });
    await mkdir(path.dirname(retainedAttachmentPath), { recursive: true });
    await writeFile(retainedAttachmentPath, retainedAttachmentBytes);
    await writeFile(path.join(iconDirectory, activeFileName), activeBytes);
    await writeFile(path.join(iconDirectory, removedFileName), removedBytes);
    store.customIcons.set(activeIconId, {
      id: activeIconId,
      user_id: userId,
      file_path: activePublicPath,
      last_used_at: "2026-07-17 00:03:00.000000",
      created_at: "2026-07-17 00:02:00.000000"
    });
    store.customIconRemovals.set(removedHash, {
      user_id: userId,
      value_hash: removedHash,
      removed_at: "2026-07-17 00:04:00.000000"
    });
    store.user.default_collection_icon = activeValue;
    store.pages.get(pageId)!.icon = removedValue;

    const exported = await request(createApp())
      .get("/api/data/export")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    const zipPath = path.join(attachmentUploadRoot, ".data-transfer", "custom-icon-roundtrip.zip");
    await mkdir(path.dirname(zipPath), { recursive: true });
    await writeFile(zipPath, exported.body as Buffer);
    const entries = await readZipDirectory(zipPath);
    const manifestEntry = entries.find((entry) => entry.name === "brainvault-backup.json");
    expect(manifestEntry).toBeTruthy();
    const manifest = JSON.parse((await readZipEntryBuffer(zipPath, manifestEntry!, 1024 * 1024)).toString("utf8"));
    expect(manifest.version).toBe(3);
    expect(manifest.retainedAttachments).toEqual([expect.objectContaining({
      fileName: retainedAttachmentId,
      path: `attachments/${retainedAttachmentId}`
    })]);
    const retainedEntry = entries.find((candidate) => candidate.name === `attachments/${retainedAttachmentId}`);
    expect(retainedEntry).toBeTruthy();
    await expect(readZipEntryBuffer(zipPath, retainedEntry!, 1024 * 1024)).resolves.toEqual(retainedAttachmentBytes);
    expect(manifest.customIcons).toHaveLength(2);
    expect(manifest.customIconLibraryRemovals).toEqual([{
      value_hash: removedHash,
      removed_at: "2026-07-17 00:04:00.000000"
    }]);
    for (const [fileName, bytes] of [[activeFileName, activeBytes], [removedFileName, removedBytes]] as const) {
      const entry = entries.find((candidate) => candidate.name === `custom-icons/${fileName}`);
      expect(entry).toBeTruthy();
      await expect(readZipEntryBuffer(zipPath, entry!, 1024 * 1024)).resolves.toEqual(bytes);
    }

    await rm(iconDirectory, { recursive: true, force: true });
    await rm(retainedAttachmentPath, { force: true });
    store.customIcons.clear();
    store.customIconRemovals.clear();
    store.user.default_collection_icon = "🧠";
    store.pages.get(pageId)!.icon = "📄";

    const restored = await request(createApp())
      .post("/api/data/import")
      .set("Authorization", `Bearer ${token}`)
      .attach("backup", exported.body as Buffer, {
        filename: "BrainVault-backup.zip",
        contentType: "application/zip"
      })
      .expect(200);

    expect(restored.body.counts.retainedAttachments).toBe(1);
    expect(restored.body.counts.customIcons).toBe(2);
    await expect(readFile(retainedAttachmentPath)).resolves.toEqual(retainedAttachmentBytes);
    await expect(readFile(path.join(iconDirectory, activeFileName))).resolves.toEqual(activeBytes);
    await expect(readFile(path.join(iconDirectory, removedFileName))).resolves.toEqual(removedBytes);
    expect(store.user.default_collection_icon).toBe(activeValue);
    expect(store.pages.get(pageId)?.icon).toBe(removedValue);
    expect(store.customIcons.get(activeIconId)).toMatchObject({
      user_id: userId,
      file_path: activePublicPath
    });
    expect(store.customIcons.has(removedIconId)).toBe(false);
    expect(store.customIconRemovals.get(removedHash)?.removed_at).toBe("2026-07-17 00:04:00.000000");
    await rm(zipPath, { force: true });
  });

  it("exports and restores database rows, page shares, and exact attachment bytes", async () => {
    store.shares.push({
      page_id: pageId,
      user_id: "usr_collaborator",
      permission: "EDIT",
      shared_by: userId,
      shared_at: "2026-07-17 00:00:20.000000"
    });
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
    expect(manifest.data.pageShares).toEqual([{
      page_id: pageId,
      shared_user_id: "usr_collaborator",
      shared_username: "collaborator",
      permission: "EDIT",
      created_at: "2026-07-17 00:00:20.000000"
    }]);
    expect(manifest.attachments[0].sha256).toMatch(/^[a-f0-9]{64}$/);

    const stalePageVersion = Number(store.pages.get(pageId)!.edit_version);
    const staleBlockVersion = Number(store.blocks.get(blockId)!.edit_version);
    const staleContentVersion = Number(store.pages.get(pageId)!.content_version);
    store.pages.get(pageId)!.title = "Changed Page";
    store.user.name = "Changed User";
    store.shares = [];
    await writeFile(getAttachmentFilePath(userId, blockId), Buffer.from("changed bytes"));

    const restored = await request(createApp())
      .post("/api/data/import")
      .set("Authorization", `Bearer ${token}`)
      .attach("backup", exported.body as Buffer, { filename: "BrainVault-backup.zip", contentType: "application/zip" })
      .expect(200);

    expect(restored.body.counts).toEqual({
      pages: 1, blocks: 1, attachments: 1, retainedAttachments: 0, pageCovers: 0, customIcons: 0, tags: 1, shares: 1
    });
    expect(restored.body.sharing).toEqual({ mode: "backup", count: 1 });
    expect(store.pages.get(pageId)?.title).toBe("Original Page");
    expect(Number(store.pages.get(pageId)?.edit_version)).toBeGreaterThan(stalePageVersion);
    expect(Number(store.blocks.get(blockId)?.edit_version)).toBeGreaterThan(staleBlockVersion);
    expect(Number(store.pages.get(pageId)?.content_version)).toBeGreaterThan(staleContentVersion);
    expect(store.pages.get(pageId)?.edit_version).toBe(store.blocks.get(blockId)?.edit_version);
    expect(store.pages.get(pageId)?.content_version).toBe(store.blocks.get(blockId)?.edit_version);
    expect(store.user.name).toBe("Original User");
    expect(store.shares).toEqual([{
      page_id: pageId,
      user_id: "usr_collaborator",
      permission: "EDIT",
      shared_by: userId,
      shared_at: "2026-07-17 00:00:20.000000"
    }]);
    expect(store.disconnectPageCollaborators).toHaveBeenCalledWith(pageId, "Workspace data is being restored");
    expect(store.restoreEvents.indexOf(`disconnect:${pageId}`)).toBeLessThan(store.restoreEvents.indexOf("delete-pages"));
    await expect(readFile(getAttachmentFilePath(userId, blockId))).resolves.toEqual(originalBytes);
  });

  it("rejects a same-named unrelated collaborator before destructive restore", async () => {
    store.shares.push({
      page_id: pageId,
      user_id: "usr_collaborator",
      permission: "EDIT",
      shared_by: userId,
      shared_at: "2026-07-17 00:00:20.000000"
    });
    const exported = await request(createApp())
      .get("/api/data/export")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    store.users.delete("usr_collaborator");
    store.users.set("usr_unrelated_collaborator", {
      id: "usr_unrelated_collaborator",
      username: "collaborator"
    });
    store.shares = [];
    store.pages.get(pageId)!.title = "Must survive identity validation";

    const response = await request(createApp())
      .post("/api/data/import")
      .set("Authorization", `Bearer ${token}`)
      .attach("backup", exported.body as Buffer, {
        filename: "BrainVault-backup.zip",
        contentType: "application/zip"
      })
      .expect(400);

    expect(response.body.error.code).toBe("INVALID_DATA_BACKUP");
    expect(response.body.error.message).toContain("Shared account identity does not match this server");
    expect(store.pages.get(pageId)?.title).toBe("Must survive identity validation");
    expect(store.shares).toEqual([]);
    expect(store.disconnectPageCollaborators).not.toHaveBeenCalled();
    expect(store.restoreEvents).not.toContain("delete-pages");
    await expect(readFile(getAttachmentFilePath(userId, blockId))).resolves.toEqual(originalBytes);
  });

  it("round-trips retained sharing grants on archived ordinary pages", async () => {
    store.pages.get(pageId)!.is_archived = 1;
    store.shares.push({
      page_id: pageId,
      user_id: "usr_collaborator",
      permission: "EDIT",
      shared_by: userId,
      shared_at: "2026-07-17 00:00:20.000000"
    });

    const exported = await request(createApp())
      .get("/api/data/export")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    store.shares = [];
    const restored = await request(createApp())
      .post("/api/data/import")
      .set("Authorization", `Bearer ${token}`)
      .attach("backup", exported.body as Buffer, {
        filename: "BrainVault-backup.zip",
        contentType: "application/zip"
      })
      .expect(200);

    expect(restored.body.sharing).toEqual({ mode: "backup", count: 1 });
    expect(store.pages.get(pageId)?.is_archived).toBe(1);
    expect(store.shares).toEqual([{
      page_id: pageId,
      user_id: "usr_collaborator",
      permission: "EDIT",
      shared_by: userId,
      shared_at: "2026-07-17 00:00:20.000000"
    }]);
  });

  it("aborts when sharing access changes while a restore is being staged", async () => {
    const exported = await request(createApp())
      .get("/api/data/export")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    store.transactionHooks = [
      () => undefined,
      () => {
        store.shares.push({
          page_id: pageId,
          user_id: "usr_new_collaborator",
          permission: "EDIT",
          shared_by: userId,
          shared_at: "2026-07-27 12:34:56.123000"
        });
      }
    ];

    const response = await request(createApp())
      .post("/api/data/import")
      .set("Authorization", `Bearer ${token}`)
      .attach("backup", exported.body as Buffer, { filename: "BrainVault-backup.zip", contentType: "application/zip" })
      .expect(409);

    expect(response.body.error.code).toBe("DATA_RESTORE_CONFLICT");
    expect(store.shares).toHaveLength(1);
    expect(store.disconnectPageCollaborators).not.toHaveBeenCalled();
    expect(store.restoreEvents).not.toContain("delete-pages");
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

  it("does not overwrite an unlinked attachment file created while restore is waiting for its lock", async () => {
    const exported = await request(createApp())
      .get("/api/data/export")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    const concurrentFileId = "blk_retained_concurrent";
    const concurrentFilePath = getAttachmentFilePath(userId, concurrentFileId);
    const concurrentBytes = Buffer.from("unlinked upload created while restore waits");
    store.transactionHooks = [
      () => undefined,
      async () => {
        await mkdir(path.dirname(concurrentFilePath), { recursive: true });
        await writeFile(concurrentFilePath, concurrentBytes);
      }
    ];

    const response = await request(createApp())
      .post("/api/data/import")
      .set("Authorization", `Bearer ${token}`)
      .attach("backup", exported.body as Buffer, { filename: "BrainVault-backup.zip", contentType: "application/zip" })
      .expect(409);

    expect(response.body.error.code).toBe("DATA_RESTORE_CONFLICT");
    await expect(readFile(concurrentFilePath)).resolves.toEqual(concurrentBytes);
    expect(store.restoreEvents).not.toContain("delete-pages");
  });

  it("does not overwrite a custom icon uploaded while restore is waiting for its lock", async () => {
    const exported = await request(createApp())
      .get("/api/data/export")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    const concurrentIconId = "cicon_concurrent_restore";
    const concurrentFileName = `${concurrentIconId}.png`;
    const concurrentPublicPath = `/upload/icons/${userId}/${concurrentFileName}`;
    const concurrentBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("created while restore waits")
    ]);
    const concurrentFilePath = path.join(customIconUploadRoot, userId, concurrentFileName);
    store.transactionHooks = [
      () => undefined,
      async () => {
        store.customIcons.set(concurrentIconId, {
          id: concurrentIconId,
          user_id: userId,
          file_path: concurrentPublicPath,
          last_used_at: "2026-07-17 00:05:00.000000",
          created_at: "2026-07-17 00:05:00.000000"
        });
        await mkdir(path.dirname(concurrentFilePath), { recursive: true });
        await writeFile(concurrentFilePath, concurrentBytes);
      }
    ];

    const response = await request(createApp())
      .post("/api/data/import")
      .set("Authorization", `Bearer ${token}`)
      .attach("backup", exported.body as Buffer, { filename: "BrainVault-backup.zip", contentType: "application/zip" })
      .expect(409);

    expect(response.body.error.code).toBe("DATA_RESTORE_CONFLICT");
    expect(store.customIcons.get(concurrentIconId)?.file_path).toBe(concurrentPublicPath);
    await expect(readFile(concurrentFilePath)).resolves.toEqual(concurrentBytes);
    expect(store.restoreEvents).not.toContain("delete-pages");
  });

  it("does not delete an attachment created while restore is waiting for its lock", async () => {
    const exported = await request(createApp())
      .get("/api/data/export")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    const concurrentBlockId = "blk_concurrent_upload";
    const concurrentBytes = Buffer.from("created while restore waits");
    store.blocks.clear();
    store.pages.get(pageId)!.content_version = 12;
    await rm(path.join(attachmentUploadRoot, userId), { recursive: true, force: true });
    store.transactionHooks = [
      () => undefined,
      async () => {
        store.blocks.set(concurrentBlockId, {
          id: concurrentBlockId,
          page_id: pageId,
          parent_block_id: null,
          type: "ATTACHMENT",
          markdown: "concurrent.txt",
          html_cache: "<p>concurrent.txt</p>",
          checked: 0,
          sort_order: 0,
          metadata: JSON.stringify({
            attachment: {
              originalName: "concurrent.txt",
              mimeType: "text/plain",
              size: concurrentBytes.length
            }
          }),
          edit_version: 1,
          created_at: "2026-07-17 00:02:00.000000",
          updated_at: "2026-07-17 00:02:00.000000"
        });
        store.pages.get(pageId)!.content_version = 13;
        await mkdir(path.dirname(getAttachmentFilePath(userId, concurrentBlockId)), { recursive: true });
        await writeFile(getAttachmentFilePath(userId, concurrentBlockId), concurrentBytes);
      }
    ];

    const response = await request(createApp())
      .post("/api/data/import")
      .set("Authorization", `Bearer ${token}`)
      .attach("backup", exported.body as Buffer, { filename: "BrainVault-backup.zip", contentType: "application/zip" })
      .expect(409);

    expect(response.body.error.code).toBe("DATA_RESTORE_CONFLICT");
    expect(store.blocks.has(concurrentBlockId)).toBe(true);
    await expect(readFile(getAttachmentFilePath(userId, concurrentBlockId))).resolves.toEqual(concurrentBytes);
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
