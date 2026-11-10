import { EventEmitter, once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), access: vi.fn(),
  blockAccess: vi.fn(), blocks: [], usage: null, rolledBack: 0, tail: Promise.resolve()
}));
vi.mock("../src/lib/db.js", () => ({
  db: state,
  transaction: async (fn) => {
    const previous = state.tail;
    let release;
    state.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const before = structuredClone(state.blocks);
    try { return await fn(state); }
    catch (error) { state.blocks = before; state.rolledBack++; throw error; }
    finally { release(); }
  }
}));
vi.mock("../src/lib/auth-sessions.js", () => ({ assertCurrentAuthSessionBoundary: vi.fn() }));
vi.mock("../src/middleware/auth.js", async (original) => ({
  ...await original(),
  requireAuth: (req, _res, next) => {
    req.user = { id: "usr_budget", username: "budget" };
    req.auth = { authVersion: 1, workspaceGeneration: 1, sessionId: "ses_budget" };
    next();
  }
}));
vi.mock("../src/lib/page-access.js", async (original) => ({
  ...await original(), getPageAccess: state.access, getBlockAccess: state.blockAccess
}));
vi.mock("../src/lib/page-version-history.js", async (original) => ({
  ...await original(), recordPageVersion: vi.fn()
}));
vi.mock("../src/lib/collaboration-lineage.js", async (original) => ({
  ...await original(), ensureCollaborationState: vi.fn().mockResolvedValue({ document_epoch: "epoch_budget" })
}));

import {
  pageResourceLimits as limits, assertStoredPageResourceBudget,
  assertPageResourceUsage, emptyPageResourceUsage, addPageBlockUsage,
  assertPageResponseBudget, assertPageRenderBudget, admitPageProjection
} from "../src/lib/page-resource-limits.js";
import { metadataSchema } from "../src/utils/schemas.js";
import { assertStructuredBlockMetadataIntegrity } from "../src/lib/structured-metadata-integrity.js";
import { assertCanonicalStructuredMetadataModel } from "../src/lib/structured-metadata-canonical.js";
import { renderBlockHtml } from "../src/lib/markdown.js";
import { toBlocksWithinPageBudget } from "../src/lib/mappers.js";
import { pageRouter } from "../src/routes/page.routes.js";
import { blockRouter } from "../src/routes/block.routes.js";
import { collaborationRouter } from "../src/routes/collaboration.routes.js";
import { authSessionCookieName } from "../src/lib/session-cookie.js";
import { errorHandler } from "../src/middleware/error.js";
import { importUserDataBackup } from "../src/lib/data-transfer.js";
import { crc32, ZipWriter } from "../src/lib/zip.js";
import { measureJsonUtf8BytesWithinLimit } from "../src/lib/data-transfer-limits.js";

const page = { id: "pag_budget", title: "Budget", owner_id: "usr_budget", is_archived: 0,
  is_collection: 0, parent_page_id: null, icon: null, cover_url: null,
  edit_version: 1, content_version: 1, created_at: "2026-11-10", updated_at: "2026-11-10" };
const access = { page, owner: { id: "usr_budget", username: "budget" }, role: "OWNER",
  scope: "OWNER", shareCount: 0, shareGeneration: null };
const block = (id = "blk_budget") => ({ id, page_id: page.id, parent_block_id: null,
  type: "MARKDOWN", markdown: "hello", html_cache: "<p>hello</p>", metadata: null,
  checked: 0, sort_order: 0, edit_version: 1, created_at: "2026-11-10", updated_at: "2026-11-10" });
function usageRows(blocks) {
  return blocks.map((b) => ({
    metadata_bytes: Buffer.byteLength(typeof b.metadata === "string" ? b.metadata : JSON.stringify(b.metadata ?? null)),
    markdown_bytes: Buffer.byteLength(b.markdown), html_cache_bytes: Buffer.byteLength(b.html_cache ?? "")
  }));
}
function app() {
  const server = express();
  server.use(express.json({ limit: "5mb" }));
  server.get("/health", (_req, res) => res.json({ ok: true }));
  server.use("/api/pages", pageRouter);
  server.use("/api", collaborationRouter);
  server.use("/api", blockRouter);
  server.use(errorHandler);
  return server;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.blocks = []; state.usage = null; state.rolledBack = 0; state.tail = Promise.resolve();
  state.access.mockResolvedValue(access);
  state.blockAccess.mockImplementation(async (id) => ({ block: state.blocks.find((b) => b.id === id), access }));
  state.query.mockImplementation(async (sql, params = []) => {
    if (sql.includes("OCTET_LENGTH(metadata)")) return (state.usage ?? usageRows(state.blocks.filter((b) => b.page_id === params[0]))).slice(0, params[1]);
    if (sql.includes("SELECT id FROM users")) return params.map((id) => ({ id }));
    if (sql.includes("SELECT id FROM pages")) return params.map((id) => ({ id }));
    if (sql.includes("SELECT * FROM blocks")) return state.blocks.filter((b) => b.page_id === params[0]);
    return [];
  });
  state.queryOne.mockImplementation(async (sql, params = []) => {
    if (sql.includes("attachment_generation")) return { id: "usr_budget", owner_id: "usr_budget",
      attachment_generation: 1, access_share_generation: null, is_archived: 0 };
    if (sql.includes("SELECT * FROM pages")) return page;
    if (sql.includes("SELECT * FROM blocks")) return state.blocks.find((b) => b.id === params[0]);
    return undefined;
  });
  state.execute.mockImplementation(async (sql, params = []) => {
    if (sql.includes("INSERT INTO blocks")) {
      state.blocks.push({ ...block(params[0]), page_id: params[1], parent_block_id: params[2], type: params[3],
        markdown: params[4], html_cache: params[5], checked: params[6], sort_order: params[7], metadata: params[8] });
    }
    return { affectedRows: 1 };
  });
});

describe("REPORT.md aggregate page resource boundary", () => {
  it("accepts the report's individual canonical payload, whose rendering already has a budget", () => {
    const metadata = { aiChat: { title: "heap-bomb", provider: "chatgpt", model: "gpt-4o", layout: "stacked",
      hideAnswerBorder: false, turns: Array.from({ length: 50 }, () => ({
        answeredAt: "2026-11-10T12:00", question: "Q", answer: "A".repeat(50_000)
      })) } };
    expect(metadataSchema.safeParse(metadata).success).toBe(true);
    expect(() => assertStructuredBlockMetadataIntegrity("AI_CHAT", metadata)).not.toThrow();
    expect(() => assertCanonicalStructuredMetadataModel("AI_CHAT", metadata)).not.toThrow();
    const bytes = Buffer.byteLength(JSON.stringify(metadata));
    expect(bytes).toBeGreaterThan(2_500_000);
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
    expect(renderBlockHtml("AI_CHAT", "", false, metadata)).toContain("resource-limited");
    const usage = emptyPageResourceUsage();
    for (let index = 0; index < 3; index++) addPageBlockUsage(usage, { markdown: "", metadata });
    expect(() => addPageBlockUsage(usage, { markdown: "", metadata })).toThrowError(
      expect.objectContaining({ statusCode: 413, code: "PAGE_METADATA_LIMIT_EXCEEDED" })
    );
  });

  it.each([
    ["blocks", "maxBlocks", "PAGE_BLOCK_LIMIT_EXCEEDED"],
    ["metadataBytes", "maxMetadataBytes", "PAGE_METADATA_LIMIT_EXCEEDED"],
    ["markdownBytes", "maxMarkdownBytes", "PAGE_MARKDOWN_LIMIT_EXCEEDED"],
    ["htmlCacheBytes", "maxHtmlCacheBytes", "PAGE_HTML_CACHE_LIMIT_EXCEEDED"]
  ])("accepts the exact %s boundary and rejects the next unit", (field, limit, code) => {
    const usage = { ...emptyPageResourceUsage(), [field]: limits[limit] };
    expect(() => assertPageResourceUsage(usage)).not.toThrow();
    expect(() => assertPageResourceUsage({ ...usage, [field]: limits[limit] + 1 })).toThrowError(
      expect.objectContaining({ statusCode: 413, code })
    );
  });

  it("bounds combined source bytes even when each component is within its individual cap", () => {
    expect(() => assertPageResourceUsage({ blocks: 1, metadataBytes: limits.maxMetadataBytes,
      markdownBytes: 1, htmlCacheBytes: limits.maxHtmlCacheBytes })).toThrowError(
      expect.objectContaining({ code: "PAGE_SOURCE_LIMIT_EXCEEDED" })
    );
    const usage = emptyPageResourceUsage();
    addPageBlockUsage(usage, { markdown: "한", metadata: { text: "글" }, htmlCache: "字" });
    expect(usage.markdownBytes).toBe(3); expect(usage.htmlCacheBytes).toBe(3);
    expect(usage.metadataBytes).toBe(Buffer.byteLength(JSON.stringify({ text: "글" })));
  });

  it("uses a bounded length-only current read for writers, without transferring any block body", async () => {
    state.usage = [{ metadata_bytes: limits.maxMetadataBytes + 1, markdown_bytes: 0, html_cache_bytes: 0 }];
    await expect(assertStoredPageResourceBudget(state, page.id, true)).rejects.toMatchObject({ statusCode: 413 });
    const [sql, params] = state.query.mock.calls[0];
    expect(sql).toContain("LIMIT ? FOR UPDATE"); expect(sql).not.toContain("SELECT *");
    expect(params).toEqual([page.id, limits.maxBlocks + 1]);
  });

  it.each(["", "/render"])("rejects existing oversized pages before loading, validating or rendering bodies (%s)", async (suffix) => {
    state.usage = [{ metadata_bytes: 6_250_000_000, markdown_bytes: 0, html_cache_bytes: 0 }];
    const response = await request(app()).get(`/api/pages/${page.id}${suffix}`).expect(413);
    expect(response.body.error.code).toBe("PAGE_METADATA_LIMIT_EXCEEDED");
    expect(state.query.mock.calls.some(([sql]) => sql.includes("SELECT * FROM blocks"))).toBe(false);
    const sql = state.query.mock.calls.find(([sql]) => sql.includes("OCTET_LENGTH(metadata)"))[0];
    expect(sql).not.toContain("FOR UPDATE");
    await request(app()).get("/health").expect(200);
  });

  it("rejects block-count-only attacks and still returns normal complete editor snapshots", async () => {
    state.usage = Array.from({ length: limits.maxBlocks + 1 }, () => ({ metadata_bytes: 0, markdown_bytes: 0, html_cache_bytes: 0 }));
    const rejected = await request(app()).get(`/api/pages/${page.id}`).expect(413);
    expect(rejected.body.error.code).toBe("PAGE_BLOCK_LIMIT_EXCEEDED");
    state.usage = null; state.blocks = [block()];
    const accepted = await request(app()).get(`/api/pages/${page.id}`).expect(200);
    expect(accepted.body.page.blocks[0].markdown).toBe("hello");
    expect(accepted.headers["cache-control"]).toBe("private, no-store");
  });

  it("rolls back block creation and version work when the persisted page crosses its cap", async () => {
    state.blocks = Array.from({ length: limits.maxBlocks }, (_, index) => block(`blk_${index}`));
    const response = await request(app()).post(`/api/pages/${page.id}/blocks`).send({ type: "MARKDOWN", markdown: "extra" }).expect(413);
    expect(response.body.error.code).toBe("PAGE_BLOCK_LIMIT_EXCEEDED");
    expect(state.blocks).toHaveLength(limits.maxBlocks); expect(state.rolledBack).toBe(1);
    expect(state.execute.mock.calls.some(([sql]) => sql.startsWith("UPDATE pages"))).toBe(false);
  });

  it("serializes two creates at the final slot and admits only one", async () => {
    state.blocks = Array.from({ length: limits.maxBlocks - 1 }, (_, index) => block(`blk_${index}`));
    const server = app();
    const responses = await Promise.all([1, 2].map((index) => request(server)
      .post(`/api/pages/${page.id}/blocks`).send({ type: "MARKDOWN", markdown: String(index) })));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 413]);
    expect(state.blocks).toHaveLength(limits.maxBlocks);
    expect(state.query.mock.calls.filter(([sql]) => sql.includes("OCTET_LENGTH(metadata)"))
      .every(([sql]) => sql.endsWith("FOR UPDATE"))).toBe(true);
  });

  it("checks the current persisted page after a content update and rolls back on overflow", async () => {
    state.blocks = [block()];
    state.usage = [{ metadata_bytes: 0, markdown_bytes: limits.maxMarkdownBytes + 1, html_cache_bytes: 0 }];
    const response = await request(app()).patch(`/api/blocks/blk_budget`)
      .send({ markdown: "new text", expectedVersion: 1 }).expect(413);
    expect(response.body.error.code).toBe("PAGE_MARKDOWN_LIMIT_EXCEEDED");
    expect(state.rolledBack).toBe(1);
    expect(state.query.mock.calls.some(([sql]) => sql.endsWith("FOR UPDATE") && sql.includes("OCTET_LENGTH(metadata)"))).toBe(true);
  });

  it("rejects a subtree move into a full destination before changing either page", async () => {
    state.blocks = [block(), ...Array.from({ length: limits.maxBlocks }, (_, index) => ({
      ...block(`blk_target_${index}`), page_id: "pag_target"
    }))];
    state.access.mockImplementation(async (id) => ({ ...access, page: { ...page, id } }));
    const response = await request(app()).post("/api/blocks/blk_budget/move").send({
      targetPageId: "pag_target", expectedVersions: [{ id: "blk_budget", version: 1 }],
      expectedSourcePageContentVersion: 1, mutationId: "move-budget"
    }).expect(413);
    expect(response.body.error.code).toBe("PAGE_BLOCK_LIMIT_EXCEEDED");
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.blocks[0].page_id).toBe(page.id);
  });

  it("bounds collaboration session bootstrap before loading the canonical block bodies", async () => {
    state.access.mockResolvedValue({ ...access, shareCount: 1 });
    state.usage = [{ metadata_bytes: limits.maxMetadataBytes + 1, markdown_bytes: 0, html_cache_bytes: 0 }];
    const response = await request(app()).post(`/api/pages/${page.id}/collaboration/session`)
      .set("Cookie", `${authSessionCookieName}=budget-session`).send({ documentEpochProtocol: 2 }).expect(413);
    expect(response.body.error.code).toBe("PAGE_METADATA_LIMIT_EXCEEDED");
    expect(state.query.mock.calls.some(([sql]) => sql.includes("SELECT * FROM blocks"))).toBe(false);
  });

  it("bounds generated caches when their stored representation was small", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ ...block(`blk_${index}`),
      html_cache: `<p>${"a".repeat(2 * 1024 * 1024)}</p>` }));
    expect(() => toBlocksWithinPageBudget(rows)).toThrowError(expect.objectContaining({ code: "PAGE_HTML_CACHE_LIMIT_EXCEEDED" }));
  });

  it("counts JSON escaping before aggregate serialization, and caps rendered output", () => {
    const value = { html: "\u0000".repeat(Math.floor(limits.maxResponseBytes / 6) + 1) };
    expect(() => assertPageResponseBudget(value)).toThrowError(expect.objectContaining({ code: "PAGE_RESPONSE_TOO_LARGE" }));
    expect(() => assertPageRenderBudget(limits.maxRenderBytes)).not.toThrow();
    expect(() => assertPageRenderBudget(limits.maxRenderBytes + 1)).toThrowError(expect.objectContaining({ code: "PAGE_RENDER_LIMIT_EXCEEDED" }));
    const dates = { createdAt: new Date("2026-11-10T00:00:00.000Z"), invalid: new Date(NaN) };
    const serializedBytes = Buffer.byteLength(JSON.stringify(dates));
    expect(measureJsonUtf8BytesWithinLimit(dates, serializedBytes)).toBe(serializedBytes);
    expect(measureJsonUtf8BytesWithinLimit(dates, serializedBytes - 1)).toBeNull();
  });

  it("holds process admission through slow response buffers and releases it exactly once", () => {
    const responses = Array.from({ length: 3 }, () => Object.assign(new EventEmitter(), { setHeader: vi.fn(), end: vi.fn() }));
    const next = vi.fn();
    admitPageProjection({}, responses[0], next); admitPageProjection({}, responses[1], next);
    admitPageProjection({}, responses[2], next);
    expect(next.mock.calls[2][0]).toMatchObject({ statusCode: 503, code: "PAGE_PROJECTION_BUSY" });
    responses[0].emit("finish"); responses[0].emit("close");
    admitPageProjection({}, responses[2], next);
    expect(next.mock.calls[3]).toEqual([]);
    responses[1].end(); responses[1].emit("close"); responses[2].emit("finish");
  });

  it("does not release process admission when a client aborts while database work is pending", () => {
    const responses = Array.from({ length: 3 }, () => Object.assign(new EventEmitter(), { setHeader: vi.fn(), end: vi.fn() }));
    const next = vi.fn();
    admitPageProjection({}, responses[0], next); admitPageProjection({}, responses[1], next);
    responses[0].emit("close");
    admitPageProjection({}, responses[2], next);
    expect(next.mock.calls[2][0]).toMatchObject({ code: "PAGE_PROJECTION_BUSY" });
    responses[0].end(); // The abandoned request finally completes its work.
    admitPageProjection({}, responses[2], next);
    expect(next.mock.calls[3]).toEqual([]);
    responses[1].emit("finish"); responses[2].emit("finish");
  });

  it("rejects an oversized backup before any destructive import SQL", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "brainvault-page-limit-"));
    try {
      const timestamp = "2026-11-10T00:00:00.000Z";
      const { owner_id, ...backupPage } = page;
      const manifest = {
        format: "brainvault-backup", version: 6, exportedAt: timestamp,
        source: { userId: "usr_budget", username: "budget" },
        account: { name: null, avatar_data: null, preferred_language: null, default_collection_icon: null, theme: "light" },
        data: { pages: [{ ...backupPage, cover_position_x: 50, cover_position_y: 50, created_at: "2026-11-10 00:00:00.000", updated_at: "2026-11-10 00:00:00.000" }],
          blocks: Array.from({ length: limits.maxBlocks + 1 }, (_, index) => ({ ...block(`blk_${index}`),
            created_at: "2026-11-10 00:00:00.000", updated_at: "2026-11-10 00:00:00.000" })), tags: [], pageTags: [], pageShares: [], collectionShares: [],
          pageComments: [], pageVersions: [], navigationCollapsedPageIds: [], navigationPageOrder: [] },
        attachments: [], retainedAttachments: [], pageCovers: [], customIcons: [], customIconLibraryRemovals: [], customIconPublications: []
      };
      const bytes = Buffer.from(JSON.stringify(manifest));
      const zipPath = path.join(directory, "backup.zip");
      const output = createWriteStream(zipPath);
      const writer = new ZipWriter(output);
      await writer.add({ name: "brainvault-backup.json", size: BigInt(bytes.length), crc32: crc32(bytes), source: { kind: "buffer", data: bytes } });
      await writer.finalize(); output.end(); await once(output, "finish");
      await expect(importUserDataBackup("usr_budget", zipPath)).rejects.toMatchObject({ statusCode: 413, code: "PAGE_BLOCK_LIMIT_EXCEEDED" });
      expect(state.execute).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
