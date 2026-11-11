import { createWriteStream, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import vm from "node:vm";
import { createDeflate, deflateSync } from "node:zlib";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertImageDimensionsWithinLimit, maxImagePixels } from "../src/lib/image-dimensions.js";
import { normalizeAvatarDataUrl } from "../src/lib/profile.js";
import { normalizeIconValue } from "../src/lib/icon-value.js";
import { inspectCustomCoverBytes, inspectCustomCoverDataUrl } from "../src/lib/page-cover.js";
import { detectCustomIconFileType, storeCustomIcon } from "../src/lib/custom-icons.js";
import { toPublicUser, toPublicUserFanout } from "../src/lib/mappers.js";
import { maxPublicProfileImageBytes } from "../src/lib/public-profile-summary.js";
import { importUserDataBackup, parseBackupManifest } from "../src/lib/data-transfer.js";
import { crc32, ZipWriter } from "../src/lib/zip.js";
import { ApiError } from "../src/lib/http.js";

const state = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), access: vi.fn() }));
vi.mock("../src/lib/db.js", () => ({ db: state, transaction: async (fn) => fn(state) }));
vi.mock("../src/lib/auth-sessions.js", async (original) => ({ ...await original(), assertCurrentAuthSession: vi.fn() }));
vi.mock("../src/middleware/auth.js", async (original) => ({
  ...await original(),
  requireAuth: (req, _res, next) => {
    req.user = { id: "usr_viewer" };
    req.auth = { authVersion: 1, workspaceGeneration: 1, sessionId: "ses_test" };
    next();
  }
}));
vi.mock("../src/lib/page-access.js", async (original) => ({ ...await original(), getPageAccess: state.access }));
import { collaborationRouter } from "../src/routes/collaboration.routes.js";
import { collectionSharingRouter } from "../src/routes/collection-sharing.routes.js";
import { pageRouter } from "../src/routes/page.routes.js";
import { authRouter } from "../src/routes/auth.routes.js";
import { customIconRouter } from "../src/routes/custom-icon.routes.js";
import { errorHandler } from "../src/middleware/error.js";

const onePixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlR0y8AAAAASUVORK5CYII=", "base64");
const dataUrl = (mime, bytes) => `data:${mime};base64,${bytes.toString("base64")}`;
const user = { id: "usr_author", username: "author", name: "Author", theme: "light",
  preferred_language: null, default_collection_icon: null, created_at: "2026-11-06", updated_at: "2026-11-06" };

function crc(bytes) {
  let value = ~0;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (~value) >>> 0;
}
function chunk(type, data = Buffer.alloc(0)) {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length);
  output.write(type, 4, "latin1");
  data.copy(output, 8);
  output.writeUInt32BE(crc(output.subarray(4, -4)), output.length - 4);
  return output;
}
function png(width, height, compressed = deflateSync(Buffer.alloc(5))) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([onePixel.subarray(0, 8), chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND")]);
}
function jpeg(width, height) {
  const output = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 0xff, 0xd9]);
  output.writeUInt16BE(height, 7); output.writeUInt16BE(width, 9);
  return output;
}
function riffChunk(type, data) {
  const output = Buffer.alloc(8 + data.length + (data.length & 1));
  output.write(type, 0, "latin1"); output.writeUInt32LE(data.length, 4); data.copy(output, 8);
  return output;
}
function webpFile(...chunks) {
  const content = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const header = Buffer.alloc(8); header.write("RIFF"); header.writeUInt32LE(content.length, 4);
  return Buffer.concat([header, content]);
}
function webp(width, height, type = "VP8L") {
  const data = Buffer.alloc(type === "VP8L" ? 5 : 10);
  if (type === "VP8L") {
    data[0] = 0x2f; data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  } else {
    data.set([0x9d, 0x01, 0x2a], 3); data.writeUInt16LE(width, 6); data.writeUInt16LE(height, 8);
  }
  return webpFile(riffChunk(type, data));
}
function webpCanvas(width, height, animated = false) {
  const header = Buffer.alloc(10); header[0] = animated ? 2 : 0;
  header.writeUIntLE(width - 1, 4, 3); header.writeUIntLE(height - 1, 7, 3);
  return riffChunk("VP8X", header);
}
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let start = header.length;
  images.forEach(({ bytes, width = 1, height = 1 }, index) => {
    const offset = 6 + 16 * index;
    header[offset] = width % 256; header[offset + 1] = height % 256;
    header.writeUInt32LE(bytes.length, offset + 8); header.writeUInt32LE(start, offset + 12);
    start += bytes.length;
  });
  return Buffer.concat([header, ...images.map(({ bytes }) => bytes)]);
}

function app() {
  const result = express();
  result.use(express.json({ limit: "4mb" }));
  result.use("/api/auth", authRouter);
  result.use("/api/custom-icons", customIconRouter);
  result.use("/api", collaborationRouter, collectionSharingRouter);
  result.use("/api/pages", pageRouter);
  result.use(errorHandler);
  return result;
}

function emptyManifest() {
  return {
    format: "brainvault-backup", version: 6, exportedAt: "2026-11-06T00:00:00.000Z",
    source: { userId: "usr_test", username: "test" },
    account: { name: null, avatar_data: null, preferred_language: null, default_collection_icon: null, theme: "light" },
    data: { pages: [], blocks: [], tags: [], pageTags: [], pageShares: [], collectionShares: [], pageComments: [],
      navigationCollapsedPageIds: [], navigationPageOrder: [], pageVersions: [] },
    attachments: [], retainedAttachments: [], pageCovers: [], customIcons: [], customIconLibraryRemovals: [], customIconPublications: []
  };
}

beforeEach(() => {
  state.query.mockReset().mockResolvedValue([]);
  state.queryOne.mockReset().mockResolvedValue({ count: 500 });
  state.execute.mockReset();
  state.access.mockReset().mockResolvedValue({ page: { id: "pag_test", owner_id: "usr_viewer", is_collection: 1 },
    role: "OWNER", scope: "OWNER", owner: user, shareCount: 1 });
});

describe("BV-2026-1106-01 profile response amplification", () => {
  const avatar = dataUrl("image/png", Buffer.alloc(512 * 1024, 0x41));
  const largeUser = { ...user, avatar_data: avatar, default_collection_icon: `image:${avatar}` };
  const comment = (index) => ({ ...largeUser, comment_id: `cmt_${String(index).padStart(4, "0")}`,
    page_id: "pag_test", user_id: user.id, body: "x", edit_version: 1,
    comment_created_at: "2026-11-06 00:00:00.000", comment_updated_at: "2026-11-06 00:00:00.000",
    cursor_created_at: "2026-11-06 00:00:00.000000" });

  it("keeps full self profiles and bounds both repeated binary profile fields", () => {
    expect(toPublicUser(largeUser).avatarData).toBe(avatar);
    const summary = toPublicUserFanout(largeUser);
    expect(summary.avatarData).toBeNull(); expect(summary.defaultCollectionIcon).toBeNull();
    const body = JSON.stringify({ comments: Array.from({ length: 500 }, (_, id) => ({ id, author: summary })) });
    expect(Buffer.byteLength(body)).toBeLessThan(200_000);
    expect(toPublicUserFanout({ ...user, avatar_data: "a".repeat(maxPublicProfileImageBytes) }).avatarData).toHaveLength(maxPublicProfileImageBytes);
    expect(toPublicUserFanout({ ...user, avatar_data: "가".repeat(maxPublicProfileImageBytes / 3 + 1) }).avatarData).toBeNull();
  });

  it("paginates equal-timestamp comments without dropping or duplicating rows and bounds SQL and JSON", async () => {
    const comments = Array.from({ length: 500 }, (_, index) => comment(index));
    state.query.mockImplementation(async (sql, args) => {
      expect(sql).toContain("CASE WHEN OCTET_LENGTH(u.avatar_data) <= 16384");
      expect(sql).toContain("CASE WHEN OCTET_LENGTH(u.default_collection_icon) <= 16384");
      expect(sql).toContain("ORDER BY pc.created_at ASC, pc.id ASC");
      const start = args.length === 5 ? comments.findIndex((entry) => entry.comment_id === args[3]) + 1 : 0;
      return comments.slice(start, start + args.at(-1));
    });
    const ids = [];
    let cursor = null;
    do {
      const response = await request(app()).get(`/api/pages/pag_test/comments${cursor ? `?cursor=${cursor}` : ""}`).expect(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.body.count).toBe(500);
      expect(response.body.comments).toHaveLength(100);
      expect(Buffer.byteLength(response.text)).toBeLessThan(100_000);
      ids.push(...response.body.comments.map((entry) => entry.id));
      cursor = response.body.nextCursor;
    } while (cursor);
    expect(ids).toEqual(comments.map((entry) => entry.comment_id));
    expect(state.access).toHaveBeenCalledTimes(5);
  });

  it.each(["limit=101", "limit=0", "limit=1.5", "cursor=invalid", "cursor=" + "x".repeat(257)])(
    "rejects invalid pagination before querying comments: %s", async (query) => {
      await request(app()).get(`/api/pages/pag_test/comments?${query}`).expect(400);
      expect(state.query).not.toHaveBeenCalled();
    });

  it("checks access again on every cursor request", async () => {
    state.access.mockRejectedValue(new ApiError(404, "PAGE_NOT_FOUND", "Page not found"));
    const cursor = Buffer.from(JSON.stringify({ createdAt: "2026-11-06 00:00:00.000000", id: "cmt_0001" })).toString("base64url");
    await request(app()).get(`/api/pages/pag_test/comments?cursor=${cursor}`).expect(404);
    expect(state.query).not.toHaveBeenCalled();
  });

  it.each(["/api/pages/pag_test/shares", "/api/collections/pag_test/shares"])("bounds shared user lists: %s", async (url) => {
    state.access.mockResolvedValue({ page: { id: "pag_test", owner_id: "usr_viewer", is_collection: url.includes("/collections/") ? 1 : 0 },
      role: "OWNER", scope: "OWNER", owner: user, shareCount: 1 });
    state.query.mockResolvedValue([{ ...largeUser, permission: "EDIT", shared_at: "2026-11-06", share_generation: "share_test" }]);
    const response = await request(app()).get(url).expect(200);
    expect(response.body.shares[0].user.avatarData).toBeNull();
    expect(response.text.length).toBeLessThan(2000);
    expect(state.query.mock.calls[0][0]).toContain("CASE WHEN OCTET_LENGTH(u.avatar_data)");
  });

  it("bounds 500 page-owner summaries in the default page listing", async () => {
    state.query.mockImplementation(async (sql) => {
      if (sql.includes("AS cursor_created_at")) return Array.from({ length: 500 }, (_, index) => ({
        id: `pag_${index}`, title: "Page", owner_id: user.id, created_at: "2026-11-06", updated_at: "2026-11-06"
      }));
      if (sql.includes("FROM users")) return [largeUser];
      return [];
    });
    const response = await request(app()).get("/api/pages?limit=500").expect(200);
    expect(response.body.pages).toHaveLength(500);
    expect(response.body.pages.every((entry) => entry.owner.avatarData === null)).toBe(true);
    expect(Buffer.byteLength(response.text)).toBeLessThan(500_000);
    expect(state.query.mock.calls.find(([sql]) => sql.includes("FROM users"))[0]).toContain("CASE WHEN OCTET_LENGTH(avatar_data)");
  });
});

describe("BV-2026-1106-02 image decoding budgets", () => {
  it("rejects a real 100 MP compressed PNG without allocating its decoded pixels", async () => {
    const compressor = createDeflate({ level: 9 });
    const compressed = [];
    compressor.on("data", (part) => compressed.push(part));
    const finished = once(compressor, "end");
    const row = Buffer.alloc(40_001);
    for (let line = 0; line < 10_000; line++) {
      if (!compressor.write(row)) await once(compressor, "drain");
    }
    compressor.end(); await finished;
    const bomb = png(10_000, 10_000, Buffer.concat(compressed));
    expect(bomb.length).toBeLessThan(512 * 1024);
    expect(() => normalizeAvatarDataUrl(dataUrl("image/png", bomb))).toThrow(/safe decoding limit/);
    expect(() => inspectCustomCoverBytes("image/png", bomb)).toThrow();
    expect(detectCustomIconFileType(bomb)).toBeNull();
    const profile = await request(app()).patch("/api/auth/profile").send({ avatarData: dataUrl("image/png", bomb) }).expect(400);
    expect(profile.body.error.code).toBe("IMAGE_DIMENSIONS_NOT_ALLOWED");
    const upload = await request(app()).post("/api/custom-icons").attach("icon", bomb, "large.png").expect(415);
    expect(upload.body.error.code).toBe("INVALID_CUSTOM_ICON_FILE");
    await expect(storeCustomIcon("usr_test", bomb)).rejects.toMatchObject({ code: "INVALID_CUSTOM_ICON_FILE" });
    expect(state.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["image/png", png(20_000, 20_000)], ["image/png", png(4001, 4000)], ["image/png", png(8193, 1)],
    ["image/jpeg", jpeg(10_000, 10_000)], ["image/webp", webp(10_000, 10_000)],
    ["image/webp", webp(10_000, 10_000, "VP8 ")]
  ])("rejects oversized dimensions at every upload/inline boundary: %s", (mime, bytes) => {
    const url = dataUrl(mime, bytes);
    expect(() => normalizeAvatarDataUrl(url)).toThrow();
    expect(() => normalizeIconValue(`image:${url}`)).toThrow();
    expect(() => inspectCustomCoverDataUrl(url)).toThrow();
    expect(detectCustomIconFileType(bytes)).toBeNull();
  });

  it.each([["image/png", onePixel], ["image/jpeg", jpeg(640, 480)], ["image/webp", webp(640, 480)],
    ["image/webp", webp(640, 480, "VP8 ")]])("accepts bounded image headers: %s", (mime, bytes) => {
    expect(() => assertImageDimensionsWithinLimit(mime, bytes)).not.toThrow();
    expect(normalizeAvatarDataUrl(dataUrl(mime, bytes))).toBe(dataUrl(mime, bytes));
    expect(detectCustomIconFileType(bytes)?.mimeType).toBe(mime);
  });

  it("checks inner WebP bitstreams rather than trusting a small VP8X canvas", () => {
    const spoofed = webpFile(webpCanvas(1, 1), webp(10_000, 10_000).subarray(12));
    expect(() => assertImageDimensionsWithinLimit("image/webp", spoofed)).toThrow();
    const extended = webpFile(webpCanvas(1, 1), webp(1, 1).subarray(12));
    expect(() => assertImageDimensionsWithinLimit("image/webp", extended)).not.toThrow();
  });

  it("bounds WebP animation frames and checks their embedded dimensions", () => {
    function animated(width, height, frames, imageWidth = width) {
      const frame = Buffer.alloc(16); frame.writeUIntLE(width - 1, 6, 3); frame.writeUIntLE(height - 1, 9, 3);
      return webpFile(webpCanvas(width, height, true), riffChunk("ANIM", Buffer.alloc(6)),
        ...Array.from({ length: frames }, () => riffChunk("ANMF", Buffer.concat([frame, webp(imageWidth, height).subarray(12)]))));
    }
    expect(() => assertImageDimensionsWithinLimit("image/webp", animated(2, 2, 2))).not.toThrow();
    expect(() => assertImageDimensionsWithinLimit("image/webp", animated(1, 1, 101))).toThrow();
    expect(() => assertImageDimensionsWithinLimit("image/webp", animated(1000, 1000, 17))).toThrow();
    expect(() => assertImageDimensionsWithinLimit("image/webp", animated(1, 1, 1, 10_000))).toThrow();
  });

  it("bounds APNG animation work as well as its static canvas", () => {
    const control = Buffer.alloc(8); control.writeUInt32BE(17);
    const base = png(1000, 1000);
    const animated = Buffer.concat([base.subarray(0, 33), chunk("acTL", control), base.subarray(33)]);
    expect(1000 * 1000).toBeLessThan(maxImagePixels);
    expect(() => assertImageDimensionsWithinLimit("image/png", animated)).toThrow();
    const smallControl = Buffer.alloc(8); smallControl.writeUInt32BE(2);
    const frame = Buffer.alloc(26); frame.writeUInt32BE(1, 4); frame.writeUInt32BE(1, 8);
    const secondFrame = Buffer.from(frame); secondFrame.writeUInt32BE(1);
    const frameData = Buffer.alloc(4); frameData.writeUInt32BE(2);
    const small = png(1, 1);
    const safeAnimation = Buffer.concat([small.subarray(0, 33), chunk("acTL", smallControl), chunk("fcTL", frame),
      small.subarray(33, -12), chunk("fcTL", secondFrame), chunk("fdAT", Buffer.concat([frameData, deflateSync(Buffer.alloc(5))])), chunk("IEND")]);
    expect(() => assertImageDimensionsWithinLimit("image/png", safeAnimation)).not.toThrow();
    expect(detectCustomIconFileType(ico([{ bytes: safeAnimation }]))).toBeNull();
  });

  it("inspects every ICO PNG/DIB payload instead of trusting its 1-byte directory dimensions", () => {
    const valid = ico([{ bytes: onePixel }]);
    expect(() => normalizeIconValue(`image:${dataUrl("image/x-icon", valid)}`)).not.toThrow();
    expect(detectCustomIconFileType(valid)?.extension).toBe("ico");
    const dib = Buffer.alloc(48); dib.writeUInt32LE(40); dib.writeInt32LE(1, 4); dib.writeInt32LE(2, 8);
    expect(detectCustomIconFileType(ico([{ bytes: dib }]))?.extension).toBe("ico");
    dib.writeInt32LE(10_000, 4); dib.writeInt32LE(20_000, 8);
    for (const bytes of [ico([{ bytes: onePixel }, { bytes: png(10_000, 10_000) }]), ico([{ bytes: dib }])]) {
      expect(detectCustomIconFileType(bytes)).toBeNull();
      expect(() => normalizeIconValue(`image:${dataUrl("image/vnd.microsoft.icon", bytes)}`)).toThrow();
    }
  });

  it("rejects malformed and truncated image containers consistently", () => {
    for (const [mime, bytes] of [["image/png", onePixel], ["image/jpeg", jpeg(1, 1)],
      ["image/webp", webp(1, 1)], ["image/vnd.microsoft.icon", ico([{ bytes: onePixel }])]]) {
      for (let length = 0; length < Math.min(bytes.length, mime === "image/jpeg" ? 14 : bytes.length); length++) {
        expect(() => assertImageDimensionsWithinLimit(mime, bytes.subarray(0, length))).toThrow();
      }
    }
  });

  it("also rejects oversized avatars and legacy inline icons during backup manifest validation", () => {
    const manifest = emptyManifest();
    expect(() => parseBackupManifest(manifest)).not.toThrow();
    manifest.account.avatar_data = dataUrl("image/png", png(10_000, 10_000));
    expect(() => parseBackupManifest(manifest)).toThrow();
    manifest.account.avatar_data = null;
    manifest.account.default_collection_icon = `image:${dataUrl("image/png", png(10_000, 10_000))}`;
    expect(() => parseBackupManifest(manifest)).toThrow();
  });

  it.each(["cover", "icon"])("rejects an oversized %s inside an integrity-valid ZIP before replacing workspace data", async (kind) => {
    const directory = await mkdtemp(path.join(tmpdir(), "brainvault-image-budget-"));
    try {
      const manifest = emptyManifest();
      const bytes = png(10_000, 10_000);
      const descriptor = { mimeType: "image/png", size: String(bytes.length), crc32: crc32(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex") };
      let entryName;
      if (kind === "cover") {
        manifest.data.pages.push({ id: "pag_test", title: "Page", icon: null, cover_url: null,
          cover_position_x: 50, cover_position_y: 50, is_archived: 0, is_collection: 0, parent_page_id: null,
          edit_version: 1, content_version: 1, created_at: "2026-11-06 00:00:00.000", updated_at: "2026-11-06 00:00:00.000" });
        entryName = "page-covers/pag_test";
        manifest.pageCovers.push({ ...descriptor, pageId: "pag_test", path: entryName });
      } else {
        entryName = "custom-icons/cicon_test.png";
        manifest.customIcons.push({ ...descriptor, fileName: "cicon_test.png", path: entryName, library: null });
      }
      expect(() => parseBackupManifest(manifest)).not.toThrow();
      const archivePath = path.join(directory, "backup.zip");
      const output = createWriteStream(archivePath);
      const writer = new ZipWriter(output);
      for (const [name, data] of [["brainvault-backup.json", Buffer.from(JSON.stringify(manifest))], [entryName, bytes]]) {
        await writer.add({ name, size: BigInt(data.length), crc32: crc32(data), source: { kind: "buffer", data } });
      }
      await writer.finalize();
      const finished = once(output, "finish"); output.end(); await finished;
      state.queryOne.mockImplementation(async sql => sql.includes("data_restore_receipts") ? undefined : manifest.account);
      await expect(importUserDataBackup("usr_test", archivePath, { authVersion: 1, sessionId: "ses_test", workspaceGeneration: 1 }, undefined,
        { admission: { userId: "usr_test", operationId: "validation", sourceKey: "upload", fingerprint: "fixture" } }))
        .rejects.toMatchObject({ code: "INVALID_DATA_BACKUP", message: expect.stringContaining(kind === "cover" ? "Page cover content is invalid" : "Custom icon content is invalid") });
      expect(state.execute).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("comment pagination in the browser", () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const loadSource = source.slice(source.indexOf("async function loadPageComments("), source.indexOf("async function submitPageComment("));
  function browser(api) {
    const context = vm.createContext({ state: { pageComments: { entries: [], requestId: 0, initialized: false } },
      workspaceNavigationGeneration: 1, isCurrentPageCommentsContext: () => true, api,
      renderPageComments: vi.fn(), t: (key) => key });
    vm.runInContext(loadSource, context);
    return context;
  }
  it("loads the next batch on demand, merges duplicates, and retains the total count", async () => {
    const api = vi.fn().mockResolvedValueOnce({ comments: [{ id: "a" }], count: 3, nextCursor: "next" })
      .mockResolvedValueOnce({ comments: [{ id: "a" }, { id: "b" }, { id: "c" }], count: 3, nextCursor: null });
    const context = browser(api);
    await context.loadPageComments("pag_test");
    expect(context.state.pageComments.entries).toHaveLength(1);
    expect(context.state.pageComments.totalCount).toBe(3);
    await context.loadPageComments("pag_test", 1, { append: true });
    expect(api.mock.calls[1][0]).toContain("?cursor=next");
    expect(Array.from(context.state.pageComments.entries, (entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(context.state.pageComments.nextCursor).toBeNull();
  });
  it("discards a late next-page response after navigation", async () => {
    let release;
    const context = browser(() => new Promise((resolve) => { release = resolve; }));
    context.state.pageComments.nextCursor = "next";
    const pending = context.loadPageComments("pag_test", 1, { append: true });
    context.isCurrentPageCommentsContext = () => false;
    release({ comments: [{ id: "stale" }], count: 1, nextCursor: null });
    await pending;
    expect(context.state.pageComments.entries).toHaveLength(0);
  });
  it("keeps newly posted comments after earlier comments loaded in a later batch", async () => {
    const context = browser(async () => ({ comments: [{ id: "middle", createdAt: "2026-11-06 00:00:02" }], count: 3, nextCursor: null }));
    context.state.pageComments.entries = [{ id: "first", createdAt: "2026-11-06 00:00:01" }, { id: "new", createdAt: "2026-11-06 00:00:03" }];
    context.state.pageComments.nextCursor = "next";
    await context.loadPageComments("pag_test", 1, { append: true });
    expect(Array.from(context.state.pageComments.entries, (entry) => entry.id)).toEqual(["first", "middle", "new"]);
  });
});
