import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  attachmentTempDir,
  cleanupStaleAttachmentTempFiles,
  formatAttachmentSize,
  getAttachmentFilePath,
  getAttachmentInfo,
  isBlockedAttachmentFilename,
  isPathInside,
  moveAttachmentFile,
  normalizeAttachmentMimeType,
  sanitizeAttachmentDownloadFilename,
  sanitizeAttachmentFilename
} from "../src/lib/attachments.js";
import { renderBlockHtml } from "../src/lib/markdown.js";

describe("Attachment metadata", () => {
  it("removes client paths and control characters from display filenames", () => {
    expect(sanitizeAttachmentFilename("../../private/report.pdf")).toBe("report.pdf");
    expect(sanitizeAttachmentFilename("C:\\Users\\me\\notes\u0000.txt")).toBe("notes_.txt");
    expect(sanitizeAttachmentFilename("..")).toBe("attachment");
  });

  it("normalizes stored metadata from JSON and rejects invalid media types", () => {
    expect(
      getAttachmentInfo(
        JSON.stringify({ attachment: { originalName: "계획서.pdf", mimeType: "application/pdf", size: 1536 } })
      )
    ).toEqual({ originalName: "계획서.pdf", mimeType: "application/pdf", size: 1536 });
    expect(normalizeAttachmentMimeType("text/html\r\nX-Test: yes")).toBe("application/octet-stream");
    expect(normalizeAttachmentMimeType("image/svg+xml")).toBe("application/octet-stream");
    expect(isBlockedAttachmentFilename("payload.svg")).toBe(true);
    expect(sanitizeAttachmentDownloadFilename("legacy.html")).toBe("legacy.html.download");
    expect(formatAttachmentSize(1536)).toBe("1.5 KB");
  });

  it("renders attachment metadata without allowing injected markup", () => {
    const html = renderBlockHtml("ATTACHMENT", "", false, {
      attachment: {
        originalName: '<img src=x onerror=alert(1)>report.pdf',
        mimeType: "application/pdf",
        size: 2048
      }
    });

    expect(html).toContain('class="rendered-attachment"');
    expect(html).toContain(">report.pdf</span>");
    expect(html).toContain("2.0 KB · application/pdf");
    expect(html).not.toContain("<img");
  });

  it("recognizes only true descendants of protected storage roots", () => {
    expect(isPathInside(path.join(process.cwd(), "public"), path.join(process.cwd(), "public", "uploads"))).toBe(true);
    expect(isPathInside(path.join(process.cwd(), "public"), path.join(process.cwd(), "public-backup"))).toBe(false);
  });

  it("removes stale upload temporary files without touching current uploads", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const stalePath = path.join(attachmentTempDir, `stale-${suffix}`);
    const freshPath = path.join(attachmentTempDir, `fresh-${suffix}`);
    await mkdir(attachmentTempDir, { recursive: true });
    await writeFile(stalePath, "stale");
    await writeFile(freshPath, "fresh");
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await utimes(stalePath, old, old);
    try {
      await cleanupStaleAttachmentTempFiles();
      await expect(readFile(stalePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(freshPath, "utf8")).resolves.toBe("fresh");
    } finally {
      await rm(stalePath, { force: true });
      await rm(freshPath, { force: true });
    }
  });

  it("never overwrites an existing attachment when a block ID collides", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const ownerId = `usr_collision_${suffix}`;
    const blockId = `blk_collision_${suffix}`;
    const target = getAttachmentFilePath(ownerId, blockId);
    const temporaryPath = path.join(attachmentTempDir, `incoming-${suffix}`);

    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(path.dirname(temporaryPath), { recursive: true });
    await writeFile(target, Buffer.from("original attachment"));
    await writeFile(temporaryPath, Buffer.from("new upload"));

    try {
      await expect(moveAttachmentFile(temporaryPath, ownerId, blockId)).rejects.toMatchObject({ code: "EEXIST" });
      await expect(readFile(target, "utf8")).resolves.toBe("original attachment");
      await expect(readFile(temporaryPath, "utf8")).resolves.toBe("new upload");
    } finally {
      await rm(path.dirname(target), { recursive: true, force: true });
      await rm(temporaryPath, { force: true });
    }
  });
});

describe("Attachment integration surface", () => {
  it("includes upload, authenticated download, cleanup, UI, and migration support", async () => {
    const [routeSource, pageRouteSource, appSource, styles, migration] = await Promise.all([
      readFile("src/routes/block.routes.ts", "utf8"),
      readFile("src/routes/page.routes.ts", "utf8"),
      readFile("public/app.js", "utf8"),
      readFile("public/styles.css", "utf8"),
      readFile("migrations/005_blocks_attachment_type.sql", "utf8")
    ]);

    expect(routeSource).toContain('attachmentUpload.single("file")');
    expect(routeSource).toContain('"/blocks/:blockId/attachment"');
    expect(routeSource).toMatch(
      /removeDeletedAttachmentFiles\([\s\S]*deletion\.ownerId,[\s\S]*deletion\.attachmentIds,[\s\S]*deletion\.attachmentGeneration/
    );
    expect(pageRouteSource).toMatch(
      /removeDeletedAttachmentFiles\([\s\S]*user\.id,[\s\S]*deletion\.attachmentIds,[\s\S]*deletion\.attachmentGeneration/
    );
    const uploadStart = routeSource.indexOf('"/pages/:pageId/attachments"');
    const uploadEnd = routeSource.indexOf('"/blocks/:blockId/attachment"', uploadStart);
    const uploadSource = routeSource.slice(uploadStart, uploadEnd);
    const userLock = uploadSource.indexOf('"SELECT id FROM users WHERE id = ? FOR UPDATE"');
    const pageLock = uploadSource.indexOf(
      "const lockedAccess = await getPageAccess(pageId, user.id, client, { lockPage: true })"
    );
    const fileMove = uploadSource.indexOf("movedPath = await moveAttachmentFile");
    const blockInsert = uploadSource.indexOf("INSERT INTO blocks");
    const earlyAuthorization = uploadSource.indexOf("authorizeAttachmentUploadTarget");
    const multipartIntake = uploadSource.indexOf('attachmentUpload.single("file")');
    expect(userLock).toBeGreaterThanOrEqual(0);
    expect(pageLock).toBeGreaterThan(userLock);
    expect(fileMove).toBeGreaterThan(pageLock);
    expect(blockInsert).toBeGreaterThan(fileMove);
    expect(earlyAuthorization).toBeGreaterThanOrEqual(0);
    expect(multipartIntake).toBeGreaterThan(earlyAuthorization);
    expect(uploadSource).toContain("lockedAccess.page.owner_id !== ownerId");
    expect(routeSource).toContain("assertDirectBlockMutationAllowed(access)");
    expect(uploadSource).toContain("assertDirectBlockMutationAllowed(lockedAccess)");
    expect(uploadSource).toContain("inspectAttachmentUpload(file.path, file.originalname, file.mimetype)");
    expect(await readFile("src/lib/attachments.ts", "utf8")).toContain("await handle.sync()");
    expect(pageRouteSource).toContain('row.type === "ATTACHMENT"');
    expect(appSource).toContain('{ type: "ATTACHMENT", command: "/file", icon: "attachment" }');
    expect(appSource).toContain("uploadAttachmentFromRow");
    expect(appSource).toContain("downloadAttachment");
    expect(styles).toContain(".attachment-block-card");
    expect(migration).toContain("'ATTACHMENT'");
  });
});
