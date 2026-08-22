import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createDatabaseFaviconDataUrl,
  createFallbackBookmarkPreview,
  createPinnedLookup,
  databaseUrlPreviewFaviconMaxBytes,
  enforceAbsoluteRequestDeadline,
  getBookmarkData,
  isRedditBookmarkUrl,
  isPrivateAddress,
  isBookmarkFetchHostAllowed,
  normalizeBookmarkUrl,
  parseBookmarkPreview,
  parseDatabaseUrlDocumentMetadata,
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

  it("does not throw on out-of-range or surrogate numeric HTML entities", () => {
    const preview = parseBookmarkPreview(
      `<html><head><meta property="og:title" content="Bad &#x200000; &#1114112; &#55296; entity"></head></html>`,
      "https://example.com/source"
    );

    expect(preview.title).toBe("Bad &#x200000; &#1114112; &#55296; entity");
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

describe("database URL document metadata", () => {
  it("uses the literal document <title> instead of OpenGraph title and resolves favicon links", () => {
    const metadata = parseDatabaseUrlDocumentMetadata(
      `<!doctype html><html><head>
        <meta property="og:title" content="OpenGraph title must not win">
        <title>Actual &amp; Document Title</title>
        <base href="https://assets.example.com/app/">
        <link rel="icon" href="first.ico" sizes="16x16">
        <link rel="icon" href="/last.ico" sizes="32x32">
        <link rel="apple-touch-icon" href="touch.png">
      </head></html>`,
      "https://www.example.com/path/page"
    );

    expect(metadata.title).toBe("Actual & Document Title");
    expect(metadata.faviconUrls).toEqual([
      "https://assets.example.com/last.ico",
      "https://assets.example.com/app/first.ico",
      "https://assets.example.com/app/touch.png",
      "https://www.example.com/favicon.ico"
    ]);
  });

  it("falls back to the hostname title and conventional /favicon.ico when metadata is absent", () => {
    expect(parseDatabaseUrlDocumentMetadata("<html><head></head></html>", "https://docs.example.org/guide")).toEqual({
      title: "docs.example.org",
      faviconUrls: ["https://docs.example.org/favicon.ico"]
    });
  });

  it("converts only bounded passive favicon image formats to CSP-compatible data URLs", () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlR0y8AAAAASUVORK5CYII=",
      "base64"
    );
    expect(createDatabaseFaviconDataUrl(png)).toBe(`data:image/png;base64,${png.toString("base64")}`);
    expect(createDatabaseFaviconDataUrl(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBe("");
    expect(createDatabaseFaviconDataUrl(Buffer.alloc(databaseUrlPreviewFaviconMaxBytes + 1, 0))).toBe("");
  });
});

describe("Reddit bookmark OpenGraph fetching", () => {
  it("only routes Reddit-owned hostnames to the Reddit-specific crawler User-Agent", () => {
    expect(isRedditBookmarkUrl("https://www.reddit.com/r/webdev/comments/abc123/example/")).toBe(true);
    expect(isRedditBookmarkUrl("https://redd.it/abc123")).toBe(true);
    expect(isRedditBookmarkUrl("https://reddit.com.evil.example/r/webdev/comments/abc123/example/")).toBe(false);
    expect(isRedditBookmarkUrl("https://evilreddit.com/r/webdev/comments/abc123/example/")).toBe(false);
    expect(bookmarkSource).toContain('const redditBookmarkUserAgent = "Twitterbot/1.0"');
    expect(bookmarkSource).toContain('"User-Agent": bookmarkFetchUserAgent(url)');
  });

  it("does not use the Reddit oEmbed fallback path", () => {
    expect(bookmarkSource).not.toContain("https://www.reddit.com/oembed");
    expect(bookmarkSource).not.toContain("fetchRedditOEmbedPreview");
    expect(bookmarkSource).not.toContain("fetchJson(");
  });
});

describe("bookmark stored URL boundary", () => {
  it("rejects local, private, and single-label intranet targets before browser rendering", () => {
    expect(normalizeBookmarkUrl("http://localhost:3000/private")).toBe("");
    expect(normalizeBookmarkUrl("http://metadata.google.internal/latest/meta-data/")).toBe("");
    expect(normalizeBookmarkUrl("http://10.0.0.7/private")).toBe("");
    expect(normalizeBookmarkUrl("http://intranet/private")).toBe("");
    expect(normalizeBookmarkUrl("https://example.com/public")).toBe("https://example.com/public");
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
    expect(data.listColumns).toBe(1);
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
        view: "list",
        listColumns: 3
      }
    });
    expect(html).toContain("rendered-bookmarks--list");
    expect(html).toContain("rendered-bookmarks--list-columns-3");
    expect(html).toContain("rendered-bookmark-favicon");
    expect(html).toContain("Unsafe &lt;script&gt;");
    expect(html).not.toContain("rendered-bookmark-description");
    expect(html).not.toContain("Description &lt;img");
  });

  it("keeps list columns backward compatible and within the supported range", () => {
    expect(getBookmarkData({ bookmark: { view: "list", items: [] } }).listColumns).toBe(1);
    expect(getBookmarkData({ bookmark: { view: "list", listColumns: 5, items: [] } }).listColumns).toBe(5);
    expect(getBookmarkData({ bookmark: { view: "list", listColumns: 9, items: [] } }).listColumns).toBe(5);
    expect(getBookmarkData({ bookmark: { view: "list", listColumns: 0, items: [] } }).listColumns).toBe(1);
    expect(getBookmarkData({ bookmark: { view: "list", listColumns: "3", items: [] } }).listColumns).toBe(1);
  });
});

describe("bookmark SSRF address filtering", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.8",
    "172.16.10.4",
    "192.168.1.10",
    "169.254.169.254",
    "168.63.129.16",
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

  it("allows public-web bookmark hosts by default, preserves optional host restrictions, and keeps SSRF guards", () => {
    expect(envSource).toContain('BOOKMARK_FETCH_ALLOWED_HOSTS');
    expect(envSource).toContain('BOOKMARK_FETCH_ALLOWED_PORTS');
    expect(bookmarkSource).toContain('isSelfOrSubdomainBookmarkFetchHost(url.hostname)');
    expect(bookmarkSource).toContain('if (hostPolicy === "bookmark" && !isBookmarkFetchHostAllowed(url.hostname))');
    expect(bookmarkSource).toContain('const addresses = await resolvePublicAddresses(url)');
    expect(bookmarkSource).toContain('lookup: createPinnedLookup(addresses)');
    expect(bookmarkSource).toContain('fetchHtml(nextUrl, redirectsLeft - 1, deadline, hostPolicy)');
    expect(bookmarkSource).toContain('fetchHtml(value, bookmarkLimits.redirects, deadline, "public")');
    expect(isBookmarkFetchHostAllowed("example.com", [])).toBe(true);
    expect(isBookmarkFetchHostAllowed("unlisted.example.net", [])).toBe(true);
    expect(isBookmarkFetchHostAllowed("example.com", ["example.com"])).toBe(true);
    expect(isBookmarkFetchHostAllowed("cdn.example.com", ["example.com"])).toBe(true);
    expect(isBookmarkFetchHostAllowed("example.com.evil.test", ["example.com"])).toBe(false);
    expect(isBookmarkFetchHostAllowed("1.1.1.1", ["1.1.1.1"])).toBe(true);
    expect(isBookmarkFetchHostAllowed("1.1.1.2", ["1.1.1.1"])).toBe(false);
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
