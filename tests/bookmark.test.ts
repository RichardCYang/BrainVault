import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createFallbackBookmarkPreview,
  createPinnedLookup,
  enforceAbsoluteRequestDeadline,
  getBookmarkData,
  isPrivateAddress,
  parseBookmarkPreview,
  prioritizeResolvedAddresses,
  renderBookmarkHtml,
  summarizeBookmarkData
} from "../src/lib/bookmark.js";
import { renderBlockHtml } from "../src/lib/markdown.js";

const bookmarkSource = readFileSync(new URL("../src/lib/bookmark.ts", import.meta.url), "utf8");
const envSource = readFileSync(new URL("../src/config/env.ts", import.meta.url), "utf8");

describe("bookmark OpenGraph parsing", () => {
  it("extracts OpenGraph data, resolves relative assets, and decodes entities", () => {
    const preview = parseBookmarkPreview(
      `<!doctype html><html><head>
        <meta content="A &amp; B" property="og:title">
        <meta name="description" content="Fallback description">
        <meta property="og:description" content="OpenGraph &quot;description&quot;">
        <meta property="og:image" content="/media/cover.jpg">
        <meta property="og:site_name" content="Example News">
        <link href="/articles/story" rel="canonical">
        <link rel="icon" href="/icons/favicon.png">
      </head></html>`,
      "https://example.com/source"
    );

    expect(preview).toEqual({
      url: "https://example.com/articles/story",
      title: "A & B",
      description: 'OpenGraph "description"',
      imageUrl: "https://example.com/media/cover.jpg",
      faviconUrl: "https://example.com/icons/favicon.png",
      siteName: "Example News"
    });
  });

  it("falls back to the document title, hostname, and favicon path", () => {
    const preview = parseBookmarkPreview(
      "<html><head><title>  Plain page  </title></head></html>",
      "https://docs.example.org/guide"
    );

    expect(preview.title).toBe("Plain page");
    expect(preview.siteName).toBe("docs.example.org");
    expect(preview.faviconUrl).toBe("https://docs.example.org/favicon.ico");
    expect(preview.imageUrl).toBe("");
  });
});

describe("bookmark data normalization and rendering", () => {
  const metadata = {
    bookmark: {
      title: "Research <script>alert(2)</script>",
      view: "gallery",
      items: [
        {
          id: "one",
          url: "https://example.com/post",
          title: "Unsafe <script>alert(1)</script>",
          description: "Description <img src=x onerror=alert(1)>",
          imageUrl: "/cover.jpg",
          faviconUrl: "/favicon.png",
          siteName: "Example"
        },
        {
          id: "duplicate",
          url: "https://example.com/post",
          title: "Duplicate"
        },
        {
          id: "invalid",
          url: "javascript:alert(1)",
          title: "Invalid"
        }
      ]
    }
  };

  it("deduplicates URLs and rejects non-HTTP links", () => {
    const data = getBookmarkData(metadata);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].imageUrl).toBe("https://example.com/cover.jpg");
    expect(data.items[0].faviconUrl).toBe("https://example.com/favicon.png");
    expect(data.title).toBe("Research <script>alert(2)</script>");
    expect(summarizeBookmarkData(data)).toContain("Research <script>alert(2)</script>");
    expect(summarizeBookmarkData(data)).toContain("https://example.com/post");
  });

  it("renders a sanitized OpenGraph gallery", () => {
    const html = renderBookmarkHtml(metadata);
    expect(html).toContain('<div class="rendered-bookmark-block"><h3>Research &lt;script&gt;alert(2)&lt;/script&gt;</h3>');
    expect(html).toContain("Research &lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).toContain('class="rendered-bookmarks rendered-bookmarks--gallery"');
    expect(html).toContain('class="rendered-bookmark-image"');
    expect(html).toContain("Unsafe &lt;script&gt;");
    expect(html).not.toContain("<script>");

    const sanitized = renderBlockHtml("BOOKMARK", "", false, metadata);
    expect(sanitized).toContain('referrerpolicy="no-referrer"');
    expect(sanitized).toContain('target="_blank"');
    expect(sanitized).not.toContain("javascript:");
  });

  it("renders list view with favicon and title but without descriptions", () => {
    const html = renderBookmarkHtml({
      bookmark: {
        ...metadata.bookmark,
        view: "list"
      }
    });
    expect(html).toContain("rendered-bookmarks--list");
    expect(html).toContain("rendered-bookmark-favicon");
    expect(html).toContain("Unsafe &lt;script&gt;");
    expect(html).not.toContain("rendered-bookmark-description");
    expect(html).not.toContain("Description &lt;img");
  });
});

describe("bookmark SSRF address filtering", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.8",
    "172.16.10.4",
    "192.168.1.10",
    "169.254.169.254",
    "192.88.99.1",
    "240.0.0.1",
    "::1",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "100::1",
    "100:0:0:1::1",
    "2002:7f00:1::",
    "3fff::1",
    "5f00::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "::ffff:127.0.0.1"
  ])("blocks private address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("allows public address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});


describe("bookmark network address selection", () => {
  it("prioritizes IPv4, keeps IPv6 fallback addresses, and removes duplicates", () => {
    expect(prioritizeResolvedAddresses([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
      { address: "1.1.1.1", family: 4 }
    ])).toEqual([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 }
    ]);
  });

  it("returns all pinned public addresses when Node requests family autoselection", async () => {
    const lookup = createPinnedLookup([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 }
    ]);

    const result = await new Promise<unknown>((resolve, reject) => {
      lookup("example.com", { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    });

    expect(result).toEqual([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 }
    ]);
  });

  it("uses approved ports, requires an HTML content type, and normalizes blocked-target failures", () => {
    expect(envSource).toContain('BOOKMARK_FETCH_ALLOWED_PORTS');
    expect(bookmarkSource).toContain('BOOKMARK_PORT_BLOCKED');
    expect(bookmarkSource).toContain('if (!contentType || !/text\/html|application\/xhtml\+xml/i.test(contentType))');
    expect(bookmarkSource).toContain('blockedTarget ? "BOOKMARK_FETCH_FAILED" : error.code');
    expect(createFallbackBookmarkPreview("http://127.0.0.1/", { includeFavicon: false }).faviconUrl).toBe("");
  });

  it("creates a usable basic bookmark when OpenGraph retrieval is unavailable", () => {
    expect(createFallbackBookmarkPreview("https://example.com/articles/1#section")).toEqual({
      url: "https://example.com/articles/1",
      title: "example.com",
      description: "",
      imageUrl: "",
      faviconUrl: "https://example.com/favicon.ico",
      siteName: "example.com"
    });
  });
});


describe("bookmark fetch deadline enforcement", () => {
  it("destroys a request at the absolute deadline even when socket activity would continue", async () => {
    vi.useFakeTimers();
    try {
      class FakeRequest extends EventEmitter {
        destroyedWith: unknown = null;

        destroy(error?: Error) {
          this.destroyedWith = error;
          return this;
        }
      }

      const request = new FakeRequest();
      enforceAbsoluteRequestDeadline(request, 1_000);
      await vi.advanceTimersByTimeAsync(999);
      expect(request.destroyedWith).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(request.destroyedWith).toMatchObject({
        statusCode: 504,
        code: "BOOKMARK_FETCH_TIMEOUT"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the absolute deadline after the request closes", async () => {
    vi.useFakeTimers();
    try {
      class FakeRequest extends EventEmitter {
        destroyedWith: unknown = null;

        destroy(error?: Error) {
          this.destroyedWith = error;
          return this;
        }
      }

      const request = new FakeRequest();
      enforceAbsoluteRequestDeadline(request, 1_000);
      request.emit("close");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(request.destroyedWith).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
