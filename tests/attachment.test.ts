import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  formatAttachmentSize,
  getAttachmentInfo,
  normalizeAttachmentMimeType,
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
    expect(routeSource).toContain("removeAttachmentFiles(user.id, attachmentIds)");
    expect(pageRouteSource).toContain("type = 'ATTACHMENT'");
    expect(appSource).toContain('{ type: "ATTACHMENT", command: "/file", icon: "attachment" }');
    expect(appSource).toContain("uploadAttachmentFromRow");
    expect(appSource).toContain("downloadAttachment");
    expect(styles).toContain(".attachment-block-card");
    expect(migration).toContain("'ATTACHMENT'");
  });
});
